import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newUsage,
  addNewUsage,
  addCacheWarmUsage,
  cacheHitRatio,
  summarizeTurns,
  mergeTurnSummaries,
  turnsFromState,
  orchestratorUsage,
  turnClass,
  usageReport,
} from "../src/usage.ts";

const asst = (ts: number, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  role: "assistant",
  timestamp: ts,
  usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite },
});

test("soma só mensagens que ainda não foram contadas (identificadas por resposta ou timestamp)", () => {
  const first = addNewUsage(newUsage(), [{ role: "user" }, asst(1, 10, 5, 100, 20)], []);
  assert.equal(first.total.input, 10);
  const second = addNewUsage(
    first.total,
    [{ role: "user" }, asst(1, 10, 5, 100, 20), { role: "user" }, asst(2, 3, 2)],
    first.counted,
  );
  assert.equal(second.total.input, 13);
  assert.equal(second.total.output, 7);
  assert.equal(second.counted.length, 2);
});

test("nova sessão na mesma pasta conta as mensagens novas, não zera nem repete", () => {
  const r = addNewUsage(addNewUsage(newUsage(), [asst(1, 10, 5)], []).total, [asst(1, 10, 5), asst(9, 4, 1)], [1]);
  assert.equal(r.total.input, 14);
});

test("dois turnos com o mesmo timestamp e responseId distintos contam ambos", () => {
  const a = { ...asst(7, 10, 1), responseId: "resp-a" };
  const b = { ...asst(7, 5, 1), responseId: "resp-b" };
  assert.equal(addNewUsage(newUsage(), [a, b], []).total.input, 15);
});

test("mesma resposta reentregue com outro timestamp (fork ou reload) não é contada de novo", () => {
  const first = addNewUsage(newUsage(), [{ ...asst(1, 10, 5), responseId: "resp-a" }], []);
  const again = addNewUsage(first.total, [{ ...asst(99, 10, 5), responseId: "resp-a" }], first.counted);
  assert.equal(again.total.input, 10);
});

test("usage.json legado (timestamp numérico) não recebe a mesma resposta de novo após o upgrade", () => {
  const legado = { total: { ...newUsage(), input: 10, totalTokens: 15 }, counted: [1] };
  const r = addNewUsage(legado.total, [{ ...asst(1, 10, 5), responseId: "resp-a" }], legado.counted);
  assert.equal(r.total.input, 10);
});

test("mensagem sem usage (ferramenta, erro) não quebra a soma", () => {
  const r = addNewUsage(newUsage(), [{ role: "toolResult" }, { role: "assistant", timestamp: 5 }, asst(6, 4, 1)], []);
  assert.equal(r.total.input, 4);
});

test("total de tokens inclui cache lido e escrito", () => {
  const r = addNewUsage(newUsage(), [asst(1, 2, 9, 35219, 33832)], []);
  assert.equal(r.total.totalTokens, 2 + 9 + 35219 + 33832);
});

const comCusto = (ts: number, total: number, fromProvider: boolean | undefined) => ({
  role: "assistant",
  timestamp: ts,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total, totalFromProvider: fromProvider },
  },
});

test("soma o custo informado e marca como reportado só se todas as parcelas vieram do provedor", () => {
  const r = addNewUsage(newUsage(), [comCusto(1, 0.5, true), comCusto(2, 0.25, true)], []);
  assert.equal(r.total.cost, 0.75);
  assert.equal(r.total.costFromProvider, true);
});

test("custo estimado pelo catálogo não é apresentado como custo reportado", () => {
  const r = addNewUsage(newUsage(), [comCusto(1, 0.5, true), comCusto(2, 0.25, false)], []);
  assert.equal(r.total.cost, 0.75);
  assert.equal(r.total.costFromProvider, false);
});

test("mensagem sem campo de custo conta tokens mas não inventa custo", () => {
  const r = addNewUsage(newUsage(), [asst(1, 10, 5)], []);
  assert.equal(r.total.cost, 0);
  assert.equal(r.total.costFromProvider, false);
});

test("usage.json antigo, sem campo de custo, continua somando", () => {
  const antigo = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
  const r = addNewUsage(antigo as ReturnType<typeof newUsage>, [asst(3, 1, 1)], [1]);
  assert.equal(r.total.input, 11);
  assert.equal(r.total.cost, 0);
});

test("taxa de acerto do cache: cacheRead / (input + cacheRead + cacheWrite)", () => {
  const u = addNewUsage(newUsage(), [asst(1, 20, 1, 80, 0)], []).total;
  assert.equal(cacheHitRatio(u), 0.8);
});

test("taxa de acerto do cache sem entrada devolve null, não zero", () => {
  assert.equal(cacheHitRatio(newUsage()), null);
});

const warmEntry = (id: string, input: number, cacheWrite: number, cost: number) => ({
  type: "usage",
  id,
  kind: "cache_warm",
  usage: { input, output: 1, cacheRead: 0, cacheWrite, totalTokens: input + 1 + cacheWrite, cost: { total: cost } },
});

test("aquecimento de cache soma só entradas cache_warm, separadas das mensagens de assistant", () => {
  const entries = [
    { type: "message", id: "m1" },
    { type: "usage", id: "u-turno", kind: "turno", usage: { input: 5, output: 5, totalTokens: 10 } },
    warmEntry("w1", 100, 0, 0.02),
  ];
  const r = addCacheWarmUsage({}, entries);
  assert.equal(r.warm.input, 100);
  assert.equal(r.warm.output, 1);
  assert.equal(r.warm.cost, 0.02);
  assert.deepEqual(r.warmIds, ["w1"]);
});

test("reinício: estado salvo em JSON e sessão relida não recontabiliza aquecimento", () => {
  const entries = [warmEntry("w1", 100, 0, 0.02)];
  const first = addCacheWarmUsage({}, entries);
  const saved = JSON.parse(JSON.stringify(first)) as { warm: typeof first.warm; warmIds: string[] };
  const again = addCacheWarmUsage(saved, entries);
  assert.equal(again.warm.input, 100);
  assert.equal(again.warm.cost, 0.02);
});

test("dois processos: o segundo soma só o aquecimento novo ao estado gravado pelo primeiro", () => {
  const processoA = addCacheWarmUsage({}, [warmEntry("w1", 100, 0, 0.02)]);
  const gravado = JSON.parse(JSON.stringify(processoA)) as typeof processoA;
  const processoB = addCacheWarmUsage(gravado, [warmEntry("w1", 100, 0, 0.02), warmEntry("w2", 50, 0, 0.01)]);
  assert.equal(processoB.warm.input, 150);
  assert.equal(processoB.warm.cost, 0.03);
  assert.deepEqual(processoB.warmIds, ["w1", "w2"]);
});

test("fork: a mesma entrada vista em dois ramos conta uma vez", () => {
  const ramoA = [warmEntry("w1", 100, 0, 0.02)];
  const ramoB = [warmEntry("w1", 100, 0, 0.02), warmEntry("w9", 7, 0, 0)];
  const r = addCacheWarmUsage(addCacheWarmUsage({}, ramoA), ramoB);
  assert.equal(r.warm.input, 107);
  assert.equal(r.warm.cost, 0.02);
});

test("cache 0 e campos ausentes viram zero, sem NaN nem custo inventado", () => {
  const r = addCacheWarmUsage({}, [{ type: "usage", id: "w3", kind: "cache_warm", usage: { input: 3 } }]);
  assert.equal(r.warm.input, 3);
  assert.equal(r.warm.cacheRead, 0);
  assert.equal(r.warm.cost, 0);
  assert.equal(Number.isNaN(r.warm.totalTokens), false);
});

const turnMsg = (ts: number, extra: Record<string, unknown> = {}) => ({
  ...asst(ts, 10, 5),
  provider: "anthropic",
  model: "claude-haiku-5-5",
  responseId: `r${ts}`,
  ...extra,
});

test("registra um turno por resposta nova com duração, sucesso, modelo, tokens e custo", () => {
  const usage = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { total: 0.002, totalFromProvider: true },
  };
  const s = addNewUsage(newUsage(), [turnMsg(1, { durationMs: 1200, stopReason: "stop", usage })], []);
  assert.deepEqual(s.turns, [
    {
      trigger: "indisponivel",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      durationMs: 1200,
      ok: true,
      totalTokens: 15,
      cost: 0.002,
    },
  ]);
});

test("turno com stopReason error ou aborted é falha; sem stopReason o status fica desconhecido", () => {
  const s = addNewUsage(
    newUsage(),
    [turnMsg(1, { stopReason: "error" }), turnMsg(2, { stopReason: "aborted" }), turnMsg(3)],
    [],
  );
  assert.deepEqual(
    s.turns!.map((t) => t.ok),
    [false, false, null],
  );
});

test("turno sem durationMs registra duração nula, não zero", () => {
  const s = addNewUsage(newUsage(), [turnMsg(1, { stopReason: "stop" })], []);
  assert.equal(s.turns![0].durationMs, null);
});

test("mesma resposta reentregue com outro timestamp não gera turno duplicado", () => {
  const first = addNewUsage(newUsage(), [turnMsg(1, { durationMs: 5 })], []);
  const again = addNewUsage(
    first.total,
    [{ ...turnMsg(1, { durationMs: 5 }), timestamp: 99 }],
    first.counted,
    first.turns,
  );
  assert.equal(again.turns!.length, 1);
});

test("estado legado sem lista de turnos mantém os totais e passa a listar só os turnos novos", () => {
  const legacy = {
    total: { ...newUsage(), input: 10, output: 5, totalTokens: 15 },
    counted: [1] as (number | string)[],
  };
  const s = addNewUsage(
    legacy.total,
    [
      asst(1, 10, 5),
      turnMsg(2, { stopReason: "stop", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 } }),
    ],
    legacy.counted,
    undefined,
  );
  assert.equal(s.total.totalTokens, 19);
  assert.equal(s.turns!.length, 1);
  assert.equal(s.turns![0].totalTokens, 4);
});

test("custo por turno soma o custo informado; resumo sem custo fica zero", () => {
  const s = summarizeTurns([
    { provider: "p", model: "a", durationMs: 1, ok: true, totalTokens: 1, cost: 0.25 },
    { provider: "p", model: "a", durationMs: 1, ok: true, totalTokens: 1, cost: 0.5 },
  ]);
  assert.equal(s.cost, 0.75);
});

test("resume turnos: falhas, desconhecidos, duração média sobre turnos com duração e contagem por modelo", () => {
  const turns = [
    { provider: "p", model: "a", durationMs: 100, ok: true, totalTokens: 1, cost: 0 },
    { provider: "p", model: "a", durationMs: null, ok: false, totalTokens: 1, cost: 0 },
    { provider: "p", model: "b", durationMs: 300, ok: null, totalTokens: 1, cost: 0 },
  ];
  assert.deepEqual(summarizeTurns(turns), {
    turns: 3,
    failed: 1,
    unknown_status: 1,
    duration_ms_total: 400,
    duration_samples: 2,
    cost: 0,
    by_model: { a: 2, b: 1 },
    by_trigger: { indisponivel: 3 },
  });
});

test("mescla resumos de tarefas somando contagens; tarefas sem resumo não entram", () => {
  const a = summarizeTurns([{ provider: "p", model: "a", durationMs: 10, ok: false, totalTokens: 1, cost: 0 }]);
  const b = summarizeTurns([{ provider: "p", model: "a", durationMs: 30, ok: true, totalTokens: 1, cost: 0 }]);
  const m = mergeTurnSummaries([a, null, b, undefined]);
  assert.equal(m!.turns, 2);
  assert.equal(m!.failed, 1);
  assert.equal(m!.duration_ms_total, 40);
  assert.equal(m!.duration_samples, 2);
  assert.equal(m!.cost, 0);
  assert.deepEqual(m!.by_model, { a: 2 });
  assert.equal(mergeTurnSummaries([null, undefined]), null);
});

test("usage.json legado com mensagens já contadas não ganha resumo parcial de turnos", () => {
  assert.equal(turnsFromState({ total: newUsage(), counted: [1, "r:x"] }), null);
});

test("tarefa nova começa com lista vazia e estado com lista mantém a lista", () => {
  assert.deepEqual(turnsFromState({ total: newUsage(), counted: [] }), []);
  const t = [{ provider: null, model: null, durationMs: 1, ok: true, totalTokens: 1, cost: 0 }];
  assert.equal(turnsFromState({ total: newUsage(), counted: ["r:x"], turns: t }), t);
});

test("gatilho do turno: mensagem de usuário, ferramenta, extensão ou indisponível quando não há anterior", () => {
  const s = addNewUsage(
    newUsage(),
    [
      { role: "assistant", responseId: "a0", timestamp: 0, usage: { totalTokens: 1 } },
      { role: "user", content: "oi", timestamp: 1 },
      { role: "assistant", responseId: "a1", timestamp: 2, usage: { totalTokens: 1 } },
      { role: "toolResult", timestamp: 3 },
      { role: "assistant", responseId: "a2", timestamp: 4, usage: { totalTokens: 1 } },
      { role: "custom", customType: "orch-event", timestamp: 5 },
      { role: "assistant", responseId: "a3", timestamp: 6, usage: { totalTokens: 1 } },
    ],
    [],
  );
  assert.deepEqual(
    s.turns!.map((t) => t.trigger),
    ["indisponivel", "mensagem-de-usuario", "ferramenta", "extensao:orch-event"],
  );
});

test("resumo de turnos conta gatilhos; turno sem gatilho gravado conta como indisponível", () => {
  const sum = summarizeTurns([
    { provider: "p", model: "a", durationMs: 1, ok: true, totalTokens: 1, cost: 0, trigger: "ferramenta" },
    { provider: "p", model: "a", durationMs: 1, ok: true, totalTokens: 1, cost: 0 },
  ]);
  assert.deepEqual(sum.by_trigger, { ferramenta: 1, indisponivel: 1 });
});

test("uso da sessão do orquestrador soma mensagens, extensões e aquecimento; dedup por resposta; origem explícita indisponível", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "status?", timestamp: 1 } },
    {
      type: "message",
      message: {
        role: "assistant",
        responseId: "r1",
        timestamp: 2,
        provider: "p",
        model: "m",
        durationMs: 40,
        stopReason: "stop",
        usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 0, totalTokens: 17, cost: { total: 0.01 } },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        responseId: "r1",
        timestamp: 2,
        provider: "p",
        model: "m",
        durationMs: 40,
        stopReason: "stop",
        usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 0, totalTokens: 17, cost: { total: 0.01 } },
      },
    },
    { type: "custom_message", customType: "orch-event", content: "aviso", display: false },
    {
      type: "message",
      message: {
        role: "assistant",
        responseId: "r2",
        timestamp: 3,
        provider: "p",
        model: "m",
        stopReason: "error",
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } },
      },
    },
    {
      type: "usage",
      kind: "cache_warm",
      id: "w1",
      provider: "p",
      model: "m",
      usage: { input: 3, output: 0, cacheRead: 100, cacheWrite: 0, totalTokens: 103, cost: { total: 0.002 } },
    },
  ];
  const r = orchestratorUsage(entries);
  assert.equal(r.origin, "indisponivel");
  assert.equal(r.totalTokens, 18);
  assert.equal(r.input, 11);
  assert.equal(r.cacheWarmCost, 0.002);
  assert.equal(r.turns.turns, 2);
  assert.equal(r.turns.failed, 1);
  assert.deepEqual(r.turns.by_trigger, { "mensagem-de-usuario": 1, "extensao:orch-event": 1 });
  assert.equal(orchestratorUsage([]).turns.turns, 0);
});

test("classe do turno: mensagem de usuário é usuário; extensão e ferramenta são automáticos; resto indisponível", () => {
  assert.equal(turnClass("mensagem-de-usuario"), "usuario");
  assert.equal(turnClass("extensao:orch-event"), "automatico");
  assert.equal(turnClass("ferramenta"), "automatico");
  assert.equal(turnClass("indisponivel"), "indisponivel");
  assert.equal(turnClass(undefined), "indisponivel");
});

test("relatório das duas sessões reais (origem e fork) conta cada resposta uma vez, com oráculo independente", async () => {
  const { readFileSync } = await import("node:fs");
  const load = (f: string) =>
    readFileSync(`test/fixtures/usage-real-pi/${f}`, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown);
  const files = [load("sessao-principal.jsonl"), load("sessao-fork.jsonl")];
  const r = usageReport(files);
  const uniq = new Map<string, { t: number; cr: number; cw: number; i: number }>();
  for (const f of files)
    for (const e of f as {
      type?: string;
      message?: { role?: string; responseId?: string; usage?: Record<string, number> };
    }[]) {
      if (e.type !== "message" || e.message?.role !== "assistant" || !e.message.usage) continue;
      const u = e.message.usage;
      uniq.set(e.message.responseId as string, {
        t: u.totalTokens ?? 0,
        cr: u.cacheRead ?? 0,
        cw: u.cacheWrite ?? 0,
        i: u.input ?? 0,
      });
    }
  const vals = [...uniq.values()];
  assert.equal(r.turns.turns, uniq.size);
  assert.equal(
    r.tokens.totalTokens,
    vals.reduce((a, v) => a + v.t, 0),
  );
  assert.equal(
    r.cache.denominator,
    vals.reduce((a, v) => a + v.i + v.cr + v.cw, 0),
  );
  assert.equal(r.cache.hit_ratio, vals.reduce((a, v) => a + v.cr, 0) / r.cache.denominator);
  assert.equal(
    r.turns.by_origin.indisponivel + r.turns.by_origin.usuario + r.turns.by_origin.automatico,
    r.turns.turns,
  );
});

test("relatório: extensão conta como automático; taxa de acerto sem denominador fica nula, não zero", () => {
  const r = usageReport([
    [
      { type: "custom_message", customType: "orch-event", content: "x", display: false },
      {
        type: "message",
        message: {
          role: "assistant",
          responseId: "z",
          timestamp: 1,
          stopReason: "stop",
          usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
        },
      },
    ],
  ]);
  assert.equal(r.turns.by_origin.automatico, 1);
  assert.equal(r.cache.hit_ratio, null);
  assert.equal(usageReport([]).turns.turns, 0);
});
