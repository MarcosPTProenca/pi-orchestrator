import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeHarness, reopenHarness, writeReport } from "./fakes.ts";
import { loadWorker } from "./worker-harness.ts";
import { appendAsk } from "../src/shared/ask.ts";
import { askMessageFor } from "../src/orchestrator/messages.ts";

const entry = (id: string, question = "Reutilizar qual contrato?") => ({
  id,
  kind: "operacional",
  question,
  context: "encontrei dois helpers",
  asked_at: "2026-11-16T12:00:00Z",
});

async function startTask(owner?: string) {
  const h = makeHarness();
  if (owner !== undefined) h.orch.setScope(owner);
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
  await h.orch.send(t.task_id, "use o helper de src/shared/x.ts", "a1");
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
  await h.orch.send(t.task_id, "resposta 1", "a1");
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

test("sequência completa: worker pergunta, orquestrador responde, worker conclui com done", async () => {
  const { h, t } = await startTask();
  const keys = ["PI_ORCH_ROLE", "PI_ORCH_TASK_ID", "PI_ORCH_TASK_DIR", "PI_ORCH_TOOL_POLICY"] as const;
  const prev = keys.map((k) => [k, process.env[k]] as const);
  try {
    delete process.env.PI_ORCH_TOOL_POLICY;
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = t.task_id;
    process.env.PI_ORCH_TASK_DIR = t.task_dir;
    const { handlers, tools } = loadWorker();
    const ctx = { sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined } };

    const asked = await tools.orch_ask.execute("c1", { kind: "operacional", question: "Reutilizar qual contrato?" });
    assert.match(asked.content[0].text, /encerre o turno/i);
    await handlers.agent_end({ messages: [] }, ctx);
    await handlers.agent_settled({}, ctx);
    assert.equal(existsSync(join(t.task_dir, "report.json")), false, "pergunta não fecha a tarefa");

    const ev = await h.orch.noticeFor(t.task_id);
    assert.equal(ev?.kind, "ask");
    assert.equal(h.orch.get(t.task_id).status, "running");
    await h.orch.send(t.task_id, "use o helper de src/shared/x.ts", ev?.ask_id);
    assert.equal(h.herdr.opsOf("prompt").length, 1);

    await handlers.agent_start({}, ctx);
    await tools.orch_report.execute("c2", { status: "done", result: "PR aberta" });
    await handlers.agent_end({ messages: [] }, ctx);
    await handlers.agent_settled({}, ctx);
    await h.orch.refresh(t.task_id);
    assert.equal(h.orch.get(t.task_id).status, "done");
    assert.equal(h.orch.get(t.task_id).result, "PR aberta");
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("reinício depois do aviso e antes da entrega reenvia a pergunta pendente uma vez", async () => {
  const { h, t } = await startTask();
  appendAsk(t.task_dir, entry("a1"));
  await h.orch.refresh(t.task_id);
  assert.equal((await h.orch.noticeFor(t.task_id))?.kind, "ask", "primeiro aviso é reivindicado");

  const restarted = reopenHarness(h);
  const replay = await restarted.pendingNotices();
  assert.equal(replay.length, 1, "a pergunta não entregue volta após o reinício");
  assert.equal(replay[0].kind, "ask");
  assert.equal(replay[0].question, "Reutilizar qual contrato?");

  restarted.markAskDelivered(t.task_id, "a1");
  const again = reopenHarness(h);
  assert.deepEqual(await again.pendingNotices(), [], "entregue não é reenviada");
});

test("pergunta entregue não volta depois de reinício", async () => {
  const { h, t } = await startTask();
  await askAndNotice(h, t, entry("a1"));
  h.orch.markAskDelivered(t.task_id, "a1");
  assert.deepEqual(await reopenHarness(h).pendingNotices(), []);
});

test("pergunta respondida antes do reinício não é reenviada", async () => {
  const { h, t } = await startTask();
  await askAndNotice(h, t, entry("a1"));
  await h.orch.send(t.task_id, "use o helper", "a1");
  assert.deepEqual(await reopenHarness(h).pendingNotices(), []);
});

test("resposta com ask_id errado é recusada e nada vai ao worker", async () => {
  const { h, t } = await startTask();
  await askAndNotice(h, t, entry("a1"));
  await assert.rejects(h.orch.send(t.task_id, "resposta", "outra"), /não está pendente/);
  assert.equal(h.herdr.opsOf("prompt").length, 0);
  assert.equal(h.orch.get(t.task_id).pending_ask?.id, "a1", "a pergunta segue pendente");
});

test("replay da mesma resposta não envia segunda vez ao worker", async () => {
  const { h, t } = await startTask();
  await askAndNotice(h, t, entry("a1"));
  await h.orch.send(t.task_id, "use o helper", "a1");
  await assert.rejects(h.orch.send(t.task_id, "use o helper", "a1"), /já foi respondida/);
  assert.equal(h.herdr.opsOf("prompt").length, 1, "um único comando ao worker");
});

test("orch_send sem ask_id com pergunta pendente após restart é recusado e cita o ask_id", async () => {
  const { h, t } = await startTask();
  await askAndNotice(h, t, entry("a1"));
  const restarted = reopenHarness(h);
  await assert.rejects(restarted.send(t.task_id, "resposta sem id"), /a1/);
  assert.equal(h.herdr.opsOf("prompt").length, 0, "nada vai ao worker sem ask_id");
  assert.equal(restarted.get(t.task_id).pending_ask?.id, "a1", "a pergunta segue pendente");
  await restarted.send(t.task_id, "resposta certa", "a1");
  assert.equal(restarted.get(t.task_id).last_answered_ask_id, "a1", "a resposta grava a correlação");
  assert.equal(restarted.get(t.task_id).pending_ask ?? null, null);
});

test("duas respostas concorrentes com o mesmo ask_id produzem um único envio", async () => {
  const { h, t } = await startTask();
  await askAndNotice(h, t, entry("a1"));
  const results = await Promise.allSettled([
    h.orch.send(t.task_id, "use o helper", "a1"),
    h.orch.send(t.task_id, "use o helper", "a1"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(h.herdr.opsOf("prompt").length, 1);
});

test("falha ao enviar ao painel mantém a pergunta pendente e a retentativa com ask_id funciona", async () => {
  const { h, t } = await startTask();
  await askAndNotice(h, t, entry("a1"));
  const real = h.herdr.prompt.bind(h.herdr);
  h.herdr.prompt = async () => {
    throw new Error("painel ocupado");
  };
  await assert.rejects(h.orch.send(t.task_id, "use o helper", "a1"), /painel ocupado/);
  assert.equal(h.orch.get(t.task_id).pending_ask?.id, "a1", "não marca como entregue");
  h.herdr.prompt = real;
  await h.orch.send(t.task_id, "use o helper", "a1");
  assert.equal(h.herdr.opsOf("prompt").length, 1);
});

test("aviso de pergunta de outra sessão do orquestrador não é entregue nem respondido", async () => {
  const { h, t } = await startTask("A");
  const other = reopenHarness(h);
  other.setScope("B");
  appendAsk(t.task_dir, entry("a1"));
  await h.orch.refresh(t.task_id);
  assert.equal(await other.noticeFor(t.task_id), null, "sessão B não recebe pergunta da sessão A");
  assert.deepEqual(
    (await other.pendingNotices()).filter((e) => e.task_id === t.task_id),
    [],
    "replay de B não traz pergunta de A",
  );
  await assert.rejects(other.send(t.task_id, "resposta", "a1"), /outra sessão do orquestrador/);
  assert.equal(h.herdr.opsOf("prompt").length, 0);
});
