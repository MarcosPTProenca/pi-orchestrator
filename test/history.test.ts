import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness, reopenHarness, writeReport } from "./fakes.ts";
import { appendAsk } from "../src/shared/ask.ts";
import { appendHistory, readHistory, HISTORY_FILE } from "../src/shared/history.ts";
import { recordOracleVerdict } from "../src/shared/ask.ts";

type Started = Awaited<ReturnType<typeof startTask>>;

const entry = (id: string, question = "Reutilizar qual contrato?") => ({
  id,
  kind: "operacional",
  question,
  context: "encontrei dois helpers",
  asked_at: "2026-11-16T12:00:00Z",
});

async function startTask(scope?: string) {
  const h = makeHarness();
  if (scope !== undefined) h.orch.setScope(scope);
  const t = await h.orch.delegate({
    project_path: h.project,
    role: "a",
    request: "x",
    objective: "y",
    mode: "direct-pr",
  });
  return { h, t };
}

// keep: pergunta do worker já coletada e avisada ao orquestrador.
async function askNotice({ h, t }: Started, id: string) {
  appendAsk(t.task_dir, entry(id));
  await h.orch.refresh(t.task_id);
  const ev = await h.orch.noticeFor(t.task_id);
  assert.ok(ev);
  return ev;
}

const items = ({ h, t }: Started) => h.orch.history(t.task_id, { limit: 20, offset: 0, detail: false }).items;

test("readHistory pagina, limita o tamanho e recorta o texto na visão compacta", () => {
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  const base = {
    at: "2026-11-16T12:00:00Z",
    from: "worker",
    to: "orquestrador",
    kind: "pergunta",
    status: "registrada",
  } as const;
  for (let i = 0; i < 25; i++) appendHistory(dir, { ...base, ref: `a${i}`, text: i === 0 ? "x".repeat(500) : "curta" });

  const first = readHistory(dir, { limit: 20, offset: 0, detail: false });
  assert.equal(first.total, 25);
  assert.equal(first.items.length, 20);
  assert.equal(first.next_offset, 20);
  assert.equal(first.items[0].ref, "a0", "ordem cronológica");
  assert.ok(first.items[0].text.length <= 161, "compacta: texto recortado");

  const second = readHistory(dir, { limit: 20, offset: 20, detail: false });
  assert.equal(second.items.length, 5);
  assert.equal(second.next_offset, null, "última página não tem próxima");

  const detail = readHistory(dir, { limit: 1, offset: 0, detail: true });
  assert.equal(detail.items[0].text.length, 500, "detalhe sob demanda traz o texto inteiro");
});

test("linha truncada por queda no meio da gravação não derruba a cronologia", () => {
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  appendHistory(dir, {
    at: "2026-11-16T12:00:00Z",
    from: "worker",
    to: "orquestrador",
    kind: "pergunta",
    status: "registrada",
    ref: "a1",
    text: "ok",
  });
  appendFileSync(join(dir, HISTORY_FILE), '{"at":"2026-11-16T12:00:0');
  appendHistory(dir, {
    at: "2026-11-16T12:01:00Z",
    from: "worker",
    to: "orquestrador",
    kind: "pergunta",
    status: "registrada",
    ref: "a2",
    text: "depois",
  });
  const page = readHistory(dir, { limit: 20, offset: 0, detail: false });
  assert.equal(page.total, 2, "a linha íntegra e a gravada depois do restart contam; a truncada não");
  assert.deepEqual(
    page.items.map((i) => i.ref),
    ["a1", "a2"],
  );
});

test("appendHistory mascara segredos antes de gravar no disco", () => {
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  appendHistory(dir, {
    at: "2026-11-16T12:00:00Z",
    from: "orquestrador",
    to: "worker",
    kind: "mensagem",
    status: "enviada",
    ref: null,
    text: "use token=abc123segredo agora",
  });
  const raw = readFileSync(join(dir, HISTORY_FILE), "utf8");
  assert.ok(!raw.includes("abc123segredo"), "segredo não fica no arquivo");
  assert.ok(raw.includes("[mascarado]"));
});

test("cronologia da tarefa: pergunta, entrega e resposta correlacionadas pelo ask_id", async () => {
  const started = await startTask();
  const ev = await askNotice(started, "a1");
  started.h.orch.markEventDelivered(ev);
  recordOracleVerdict(started.t.task_dir, "a1", "answered");
  await started.h.orch.send(started.t.task_id, "use o helper de src/shared/x.ts", "a1");

  assert.deepEqual(
    items(started).map((i) => [i.from, i.to, i.kind, i.status, i.ref]),
    [
      ["worker", "orquestrador", "pergunta", "registrada", "a1"],
      ["worker", "orquestrador", "entrega", "entregue", "a1"],
      ["orquestrador", "worker", "resposta", "enviada", "a1"],
    ],
  );
  assert.equal(items(started)[2].text, "[resposta à pergunta a1] use o helper de src/shared/x.ts");
});

test("entrega registrada uma vez mesmo se o aviso for reentregue", async () => {
  const started = await startTask();
  const ev = await askNotice(started, "a1");
  started.h.orch.markEventDelivered(ev);
  started.h.orch.markEventDelivered(ev);
  assert.equal(items(started).filter((i) => i.kind === "entrega").length, 1);
});

test("falha ao enviar ao painel fica registrada como falhou", async () => {
  const started = await startTask();
  const { h, t } = started;
  await askNotice(started, "a1");
  recordOracleVerdict(t.task_dir, "a1", "answered");
  const real = h.herdr.prompt.bind(h.herdr);
  h.herdr.prompt = () => Promise.reject(new Error("painel indisponível"));
  await assert.rejects(h.orch.send(t.task_id, "resposta", "a1"));
  h.herdr.prompt = real;
  assert.deepEqual(
    items(started)
      .filter((i) => i.kind === "resposta")
      .map((i) => i.status),
    ["falhou"],
  );
});

test("relatório do worker entra na cronologia", async () => {
  const started = await startTask();
  writeReport(started.t.task_dir, started.t.task_id, { status: "done", result: "PR aberta" });
  await started.h.orch.refresh(started.t.task_id);
  const rel = items(started).find((i) => i.kind === "relatorio");
  assert.ok(rel, "relatório aparece");
  assert.equal(rel.from, "worker");
  assert.equal(rel.status, "done");
  assert.equal(rel.text, "PR aberta");
});

test("cronologia sobrevive a restart e continua ordenada", async () => {
  const started = await startTask();
  started.h.orch.markEventDelivered(await askNotice(started, "a1"));
  const before = items(started);
  const after = reopenHarness(started.h).history(started.t.task_id, { limit: 20, offset: 0, detail: false }).items;
  assert.deepEqual(after, before);
});

test("history é somente leitura: não altera estado nem consome o aviso", async () => {
  const started = await startTask();
  const { h, t } = started;
  appendAsk(t.task_dir, entry("a1"));
  await h.orch.refresh(t.task_id);
  const stateBefore = JSON.stringify(h.orch.list());
  h.orch.history(t.task_id, { limit: 20, offset: 0, detail: true });
  assert.equal(JSON.stringify(h.orch.list()), stateBefore);
  assert.ok(await h.orch.noticeFor(t.task_id), "o aviso da pergunta continua pendente após a consulta");
});

test("history respeita o isolamento por sessão (owner)", async () => {
  const started = await startTask("sessao-a");
  await askNotice(started, "a1");
  const outra = reopenHarness(started.h);
  outra.setScope("sessao-b");
  assert.throws(() => outra.history(started.t.task_id, { limit: 20, offset: 0, detail: false }), /esta sessão só age/);
});

test("falha ao gravar a cronologia não faz um envio já entregue parecer falho", async () => {
  const { h, t } = await startTask();
  rmSync(t.task_dir, { recursive: true, force: true });
  writeFileSync(t.task_dir, "não é um diretório");
  await h.orch.send(t.task_id, "oi");
  assert.equal(h.herdr.opsOf("prompt").length, 1, "a mensagem foi entregue ao painel");
});
