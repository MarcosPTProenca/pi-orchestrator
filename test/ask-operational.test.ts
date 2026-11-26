import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, writeReport } from "./fakes.ts";
import { appendAsk } from "../src/shared/ask.ts";
import { askMessageFor } from "../src/orchestrator/messages.ts";

const entry = (id: string, question = "Reutilizar qual contrato?") => ({
  id,
  kind: "operacional",
  question,
  context: "encontrei dois helpers",
  asked_at: "2026-11-16T12:00:00Z",
});

async function startTask() {
  const h = makeHarness();
  const t = await h.orch.delegate({
    project_path: h.project,
    role: "a",
    request: "x",
    objective: "y",
    mode: "direct-pr",
  });
  return { h, t };
}

async function askAndNotice(
  h: Awaited<ReturnType<typeof startTask>>["h"],
  t: Awaited<ReturnType<typeof startTask>>["t"],
  e: ReturnType<typeof entry>,
) {
  appendAsk(t.task_dir, e);
  await h.orch.refresh(t.task_id);
  return h.orch.noticeFor(t.task_id);
}

test("pergunta operacional chega como aviso sem mudar o status nem entrar no inbox", async () => {
  const { h, t } = await startTask();
  appendAsk(t.task_dir, entry("a1"));
  await h.orch.refresh(t.task_id);
  const ev = await h.orch.noticeFor(t.task_id);
  assert.ok(ev, "o orquestrador recebe a pergunta");
  assert.equal(ev.kind, "ask");
  assert.equal(ev.status, "running", "não vira blocked");
  assert.equal(ev.question, "Reutilizar qual contrato?");
  assert.equal(h.orch.get(t.task_id).status, "running");
  assert.equal(h.orch.get(t.task_id).question, null, "não grava pergunta de decisão humana");
  const inbox = await h.orch.inbox({ consume: false });
  assert.equal(
    inbox.some((e) => e.task_id === t.task_id),
    false,
    "não aparece no inbox como decisão pendente",
  );
});

test("a mesma pergunta não é avisada duas vezes", async () => {
  const { h, t } = await startTask();
  appendAsk(t.task_dir, entry("a1"));
  await h.orch.refresh(t.task_id);
  assert.ok(await h.orch.noticeFor(t.task_id));
  await h.orch.refresh(t.task_id);
  assert.equal(await h.orch.noticeFor(t.task_id), null, "não repete");
});

test("send responde a pergunta pelo canal do worker, sem orch_answer, e a tarefa segue running", async () => {
  const { h, t } = await startTask();
  await askAndNotice(h, t, entry("a1"));
  await h.orch.send(t.task_id, "use o helper de src/shared/x.ts");
  const prompts = h.herdr.opsOf("prompt");
  assert.equal(prompts.length, 1, "a resposta vai como mensagem ao painel do worker");
  assert.equal(h.orch.get(t.task_id).status, "running");
  assert.equal(h.orch.get(t.task_id).pending_ask ?? null, null, "pergunta respondida sai do pendente");
  await h.orch.refresh(t.task_id);
  assert.equal(await h.orch.noticeFor(t.task_id), null, "a mesma pergunta não volta depois da resposta");
});

test("pergunta nova depois de uma respondida gera novo aviso", async () => {
  const { h, t } = await startTask();
  await askAndNotice(h, t, entry("a1"));
  await h.orch.send(t.task_id, "resposta 1");
  appendAsk(t.task_dir, entry("a2", "Usar o módulo B?"));
  await h.orch.refresh(t.task_id);
  const ev = await h.orch.noticeFor(t.task_id);
  assert.equal(ev?.question, "Usar o módulo B?");
});

test("relatório blocked continua sendo decisão humana, sem afetar o fluxo de pergunta", async () => {
  const { h, t } = await startTask();
  writeReport(t.task_dir, t.task_id, { status: "blocked", question: "Mudar a arquitetura?" }, "1");
  await h.orch.refresh(t.task_id);
  assert.equal(h.orch.get(t.task_id).status, "blocked");
  assert.equal((await h.orch.noticeFor(t.task_id))?.kind, undefined, "blocked segue o aviso comum");
});

test("texto do aviso manda responder por orch_send só com autorização e escalar caso contrário", () => {
  const msg = askMessageFor({
    task_id: "t-1",
    project_id: "p",
    status: "running",
    result: null,
    question: "Reutilizar qual contrato?",
    artifacts: [],
    error: null,
    kind: "ask",
  });
  assert.match(msg, /orch_send/);
  assert.match(msg, /autorizada/);
  assert.match(msg, /não use orch_answer/i);
  assert.match(msg, /Reutilizar qual contrato\?/);
});

test("worker ocioso aguardando resposta falha com motivo de pergunta sem resposta, não de relatório", async () => {
  const { h, t } = await startTask();
  await askAndNotice(h, t, entry("a1"));
  const idle = (minutes: number) => {
    h.clock.ms += minutes * 60_000;
    h.herdr.panesList = h.herdr.panesList.map((p) =>
      p.pane_id === t.pane_id ? { ...p, agent: "pi", agent_status: "idle" } : p,
    );
    return h.orch.refresh(t.task_id);
  };
  await idle(0);
  await idle(11);
  const after = h.orch.get(t.task_id);
  assert.equal(after.status, "failed", "sem resposta, o limite de ociosidade ainda encerra a tarefa");
  assert.match(after.error ?? "", /aguard\w* resposta/, "o motivo diz que faltou resposta à pergunta");
  assert.doesNotMatch(after.error ?? "", /não entregou relatório/);
});
