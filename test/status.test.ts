import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageText,
  buildStatus,
  compactStatus,
  COMPACT_OPEN_LIMIT,
  COMPACT_TERMINAL_LIMIT,
  DEFAULT_OLD_HOURS,
  oldHoursFrom,
} from "../src/status.ts";
import type { TaskRecord } from "../src/contract.ts";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const t = (over: Record<string, unknown>) =>
  ({
    project_path: "/x",
    worker_id: "w",
    workspace_id: "",
    tab_id: "",
    terminal_id: "",
    error: null,
    last_report_key: null,
    notified: false,
    task_dir: "",
    brief_path: "",
    prompt_attempts: 1,
    worker_started: true,
    task_id: "t-1",
    project_id: "alpha",
    role: "a",
    status: "running",
    model: null,
    pane_id: "",
    question: null,
    deadline_at: null,
    verification: null,
    result: null,
    artifacts: [] as string[],
    created_at: "2026-11-17T11:00:00Z",
    updated_at: "2026-11-17T11:30:00Z",
    ...over,
  }) as unknown as TaskRecord;

test("ageText escreve a idade de forma curta", () => {
  assert.equal(ageText(45_000), "45 s");
  assert.equal(ageText(12 * 60_000), "12 min");
  assert.equal(ageText((3 * 60 + 5) * 60_000), "3 h 5 min");
  assert.equal(ageText(50 * 60 * 60_000), "2 d 2 h");
});

test("agrupa por projeto, com idade e resumo curto", () => {
  const out = buildStatus(
    [
      t({ task_id: "t-1", project_id: "alpha" }),
      t({
        task_id: "t-2",
        project_id: "beta",
        status: "done",
        result: "x".repeat(500),
        artifacts: ["https://github.com/o/r/pull/3"],
        updated_at: "2026-11-17T11:50:00Z",
      }),
    ],
    NOW,
    {},
  );
  assert.deepEqual(
    out.map((g) => g.project_id),
    ["alpha", "beta"],
  );
  assert.equal(out[0].tasks[0].age, "1 h 0 min");
  assert.equal(out[1].tasks[0].result!.length <= 200, true);
  assert.deepEqual(out[1].tasks[0].artifacts, ["https://github.com/o/r/pull/3"]);
});

test("por padrão esconde canceladas e terminais antigas; all mostra tudo", () => {
  const old = t({ task_id: "t-old", status: "done", updated_at: "2026-11-15T12:00:00Z" });
  const cancelled = t({ task_id: "t-c", status: "cancelled" });
  const recent = t({ task_id: "t-r", status: "done", updated_at: "2026-11-17T11:50:00Z" });
  const ids = (o: ReturnType<typeof buildStatus>) => o.flatMap((g) => g.tasks.map((x) => x.task_id)).sort();
  assert.deepEqual(ids(buildStatus([old, cancelled, recent], NOW, {})), ["t-r"]);
  assert.deepEqual(ids(buildStatus([old, cancelled, recent], NOW, { all: true })), ["t-c", "t-old", "t-r"].sort());
  assert.equal(DEFAULT_OLD_HOURS, 24);
});

test("tarefa ativa nunca some, mesmo antiga", () => {
  const ativa = t({ task_id: "t-a", status: "blocked", created_at: "2026-11-10T00:00:00Z", question: "A ou B?" });
  const out = buildStatus([ativa], NOW, {});
  assert.equal(out[0].tasks[0].question, "A ou B?");
});

test("orch_status mostra o total de tokens quando medido, senão null", () => {
  const withUsage = t({
    task_id: "t-u",
    status: "done",
    updated_at: "2026-11-17T11:50:00Z",
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 },
  });
  const without = t({ task_id: "t-n", status: "running" });
  const rows = buildStatus([withUsage, without], NOW, {}).flatMap((g) => g.tasks);
  assert.equal(rows.find((r) => r.task_id === "t-u")?.tokens, 10);
  assert.equal(rows.find((r) => r.task_id === "t-n")?.tokens, null);
});

test("orch_status expõe a taxa de acerto do cache e null quando não há entrada", () => {
  const cached = t({
    task_id: "t-c",
    status: "done",
    updated_at: "2026-11-17T11:50:00Z",
    usage: { input: 20, output: 1, cacheRead: 80, cacheWrite: 0, totalTokens: 101 },
  });
  const semUso = t({ task_id: "t-s", status: "running" });
  const rows = buildStatus([cached, semUso], NOW, {}).flatMap((g) => g.tasks);
  assert.equal(rows.find((r) => r.task_id === "t-c")?.cache_hit_ratio, 0.8);
  assert.equal(rows.find((r) => r.task_id === "t-s")?.cache_hit_ratio, null);
});

test("orch_status expõe custo informado e custo do aquecimento de cache; null sem uso", () => {
  const custo = t({
    task_id: "t-k",
    status: "done",
    updated_at: "2026-11-17T11:50:00Z",
    usage: {
      input: 20,
      output: 1,
      cacheRead: 80,
      cacheWrite: 0,
      totalTokens: 101,
      cost: 0.4,
      costFromProvider: true,
      cacheWarmCost: 0.02,
    },
  });
  const rows = buildStatus([custo, t({ task_id: "t-z", status: "running" })], NOW, {}).flatMap((g) => g.tasks);
  const k = rows.find((r) => r.task_id === "t-k");
  assert.equal(k?.cost_usd, 0.4);
  assert.equal(k?.cost_from_provider, true);
  assert.equal(k?.cache_warm_cost_usd, 0.02);
  const z = rows.find((r) => r.task_id === "t-z");
  assert.equal(z?.cost_usd, null);
  assert.equal(z?.cost_from_provider, null);
  assert.equal(z?.cache_warm_cost_usd, null);
});

test("PI_ORCH_OLD_HOURS: 0 vale (esconde todas as terminais); valor inválido vira padrão, não zero", () => {
  assert.equal(oldHoursFrom("0"), 0);
  assert.equal(oldHoursFrom("12"), 12);
  assert.equal(oldHoursFrom("2.5"), 2.5);
  assert.equal(oldHoursFrom(undefined), undefined);
  assert.equal(oldHoursFrom(""), undefined);
  assert.equal(oldHoursFrom("abc"), undefined);
  assert.equal(oldHoursFrom("-1"), undefined);
});

test("com 0 horas, terminais somem da listagem e ativas continuam", () => {
  const done = t({ task_id: "t-d", status: "done", updated_at: "2026-11-17T11:59:59Z" });
  const running = t({ task_id: "t-r", status: "running" });
  const ids = buildStatus([done, running], NOW, { oldHours: 0 }).flatMap((g) => g.tasks.map((x) => x.task_id));
  assert.deepEqual(ids, ["t-r"]);
});

test("compacto: bloqueada e ativa saem inteiras; terminais ficam limitadas às mais recentes", () => {
  const terminais = Array.from({ length: COMPACT_TERMINAL_LIMIT + 5 }, (_, i) =>
    t({
      task_id: `t-d${i}`,
      status: "done",
      updated_at: `2026-11-17T11:${String(i).padStart(2, "0")}:00Z`,
      result: "r".repeat(300),
    }),
  );
  const bloqueada = t({ task_id: "t-b", status: "blocked", question: "A ou B?", created_at: "2026-11-10T00:00:00Z" });
  const [grupo] = compactStatus(buildStatus([...terminais, bloqueada, t({ task_id: "t-r" })], NOW, {}));
  const ids = grupo.tasks.map((r) => r.task_id);
  assert.ok(ids.includes("t-b"));
  assert.ok(ids.includes("t-r"));
  assert.equal(grupo.tasks.filter((r) => r.status === "done").length, COMPACT_TERMINAL_LIMIT);
  assert.equal(ids.includes("t-d0"), false, "a terminal mais antiga fica de fora");
  assert.equal(grupo.omitted_terminal, 5);
  assert.equal(grupo.counts.done, COMPACT_TERMINAL_LIMIT + 5);
  assert.equal(grupo.tasks.find((r) => r.task_id === "t-b")?.question, "A ou B?");
});

test("compacto: abertas acima do teto ficam de fora com omitted_open; bloqueadas vêm primeiro", () => {
  const abertas = Array.from({ length: COMPACT_OPEN_LIMIT + 7 }, (_, i) =>
    t({ task_id: `t-a${i}`, status: "running", updated_at: `2026-11-17T11:${String(i % 60).padStart(2, "0")}:00Z` }),
  );
  const bloqueada = t({ task_id: "t-bq", status: "blocked", question: "?", updated_at: "2026-11-01T00:00:00Z" });
  const [grupo] = compactStatus(buildStatus([...abertas, bloqueada], NOW, {}));
  assert.equal(grupo.tasks.length, COMPACT_OPEN_LIMIT);
  assert.equal(grupo.tasks[0].task_id, "t-bq", "bloqueada primeiro mesmo sendo a mais antiga");
  assert.equal(grupo.omitted_open, 8);
  assert.equal(grupo.counts.running, COMPACT_OPEN_LIMIT + 7, "contagem continua completa");
});

test("compacto: resultado truncado a 120 e URL de PR preservada em artefatos", () => {
  const pr = "https://github.com/o/r/pull/9";
  const [grupo] = compactStatus(
    buildStatus([t({ task_id: "t-x", status: "done", result: "x".repeat(400), artifacts: [pr] })], NOW, {}),
  );
  const r = grupo.tasks[0];
  assert.ok(r.result !== null && r.result.length <= 120);
  assert.deepEqual(r.artifacts, [pr]);
});

test("buildStatus filtra por tarefa e por projeto; fullResult devolve o texto inteiro", () => {
  const tasks = [
    t({ task_id: "t-1", project_id: "alpha", status: "done", result: "y".repeat(500) }),
    t({ task_id: "t-2", project_id: "beta", status: "running" }),
  ];
  const porTarefa = buildStatus(tasks, NOW, { taskId: "t-1", all: true, fullResult: true }).flatMap((g) => g.tasks);
  assert.equal(porTarefa.length, 1);
  assert.equal(porTarefa[0].result?.length, 500);
  const porProjeto = buildStatus(tasks, NOW, { projectId: "beta" }).flatMap((g) => g.tasks.map((r) => r.task_id));
  assert.deepEqual(porProjeto, ["t-2"]);
});

test("tamanho da saída compacta cresce pouco com o número de tarefas (fixture 1, 20, 200)", () => {
  const fixture = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      t({
        task_id: `t-${i}`,
        project_id: `p-${i % 4}`,
        status: i % 3 === 0 ? "running" : "done",
        result: "Implementado e verificado com testes; PR aberta. ".repeat(12),
        artifacts: [`https://github.com/o/r/pull/${i}`],
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 6, cost: 0.01, costFromProvider: true },
      }),
    );
  const size = (n: number) => JSON.stringify(compactStatus(buildStatus(fixture(n), NOW, { all: true }))).length;
  const [s1, s20, s200] = [size(1), size(20), size(200)];
  assert.ok(s200 < 40_000, `saída compacta com 200 tarefas: ${s200} caracteres`);
  assert.ok(s1 < s20 && s20 < s200, "cresce com o número de tarefas");
});

test("links: URL além do corte de 120 caracteres continua visível na saída compacta", () => {
  const result = `${"x".repeat(150)} PR https://github.com/o/r/pull/9.`;
  const out = compactStatus(
    buildStatus([t({ task_id: "t-9", status: "done", result, updated_at: "2026-11-17T11:50:00Z" })], NOW, {}),
  );
  const row = out[0].tasks[0];
  assert.ok(!row.result!.includes("pull/9"));
  assert.deepEqual(row.links, ["https://github.com/o/r/pull/9"]);
});
