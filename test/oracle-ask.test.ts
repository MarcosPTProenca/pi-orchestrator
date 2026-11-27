import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./fakes.ts";
import { asWorker, reportDone } from "./worker-harness.ts";
import { askMessageFor } from "../src/orchestrator/messages.ts";
import {
  oracleContract,
  parseOracleAnswer,
  settleOracleVerdict as settleRaw,
  type SettleInput,
} from "../src/orchestrator/oracle-ask.ts";
import { consultToken, ORACLE_AGENT, OracleCaptures } from "../src/orchestrator/oracle-guard.ts";
import { latestAsk } from "../src/shared/ask.ts";

const answered = (answer = "use o helper de src/shared/x.ts") =>
  JSON.stringify({ verdict: "answered", answer, reason: "spec cita o helper", uncertainty: "" });

// keep: nos testes de fluxo, a saída real do subagent é o próprio raw; o caso sem captura fica nos testes do oracle-guard.
const settleOracleVerdict = (i: Omit<SettleInput, "capture">) =>
  settleRaw({
    ...i,
    capture: { token: consultToken(i.taskId, i.askId), agent: "oracle", model: null, toolCallId: "c1", output: i.raw },
  });

const contractInput = {
  taskId: "t-1",
  askId: "a1",
  question: "Reutilizar qual contrato?",
  askContext: "encontrei dois helpers",
  projectLabel: "proj",
  projectPath: "/repo/proj",
  objective: "X funciona",
  source: "https://github.com/o/r/issues/221",
  visionPath: "/repo/proj/VISION.md",
};

async function startTask() {
  const h = makeHarness();
  const t = await h.orch.delegate({
    project_path: h.project,
    role: "a",
    request: "pedido do usuário com contexto longo",
    objective: "X funciona",
    mode: "direct-pr",
    source: "https://github.com/o/r/issues/221",
  });
  return { h, t };
}

// keep: pergunta feita pelo worker real (extensão carregada) e lida pelo orquestrador; devolve o id da pergunta.
async function askWorker(h: ReturnType<typeof makeHarness>, t: { task_id: string; task_dir: string }) {
  await asWorker(t, async ({ tools, endTurn }) => {
    await tools.orch_ask.execute("c1", { kind: "operacional", question: "Reutilizar qual contrato?" });
    await endTurn();
  });
  const ev = await h.orch.noticeFor(t.task_id);
  assert.ok(ev?.ask_id, "a pergunta chega ao orquestrador com id");
  return ev.ask_id;
}

test("parseOracleAnswer aceita JSON com cerca de código e devolve só answer quando answered", () => {
  const p = parseOracleAnswer("```json\n" + answered("use A") + "\n```");
  assert.equal(p.verdict, "answered");
  assert.equal(p.answer, "use A");
  const q = parseOracleAnswer(
    JSON.stringify({ verdict: "inconclusive", answer: "ignorado", reason: "faltou o teste" }),
  );
  assert.equal(q.answer, null, "sem orientação quando não é answered");
});

test("parseOracleAnswer recusa formato fora do contrato", () => {
  assert.throws(() => parseOracleAnswer("não é json"), /JSON/);
  assert.throws(() => parseOracleAnswer('{"verdict":"talvez","reason":"x"}'), /verdict inválido/);
  assert.throws(() => parseOracleAnswer('{"verdict":"answered","reason":"x"}'), /answer obrigatório/);
  assert.throws(() => parseOracleAnswer('{"verdict":"inconclusive","reason":" "}'), /reason obrigatório/);
  assert.throws(() => parseOracleAnswer("null"), /verdict inválido/);
});

test("contrato do Oracle leva pergunta, contexto e ponteiros, não a conversa, e tem teto de tamanho", () => {
  const text = oracleContract(contractInput);
  assert.ok(text.includes("Reutilizar qual contrato?"));
  assert.ok(text.includes("encontrei dois helpers"));
  assert.ok(text.includes("https://github.com/o/r/issues/221"));
  assert.ok(text.includes("/repo/proj/VISION.md"), "aponta a visão sem colar o conteúdo");
  assert.match(text, /somente leitura/);
  assert.match(text, /read, grep, find, ls/);
  assert.doesNotMatch(text, /git log|git diff|git show|bash/, "contrato não pede ferramenta que executa");
  assert.ok(
    text.includes(`Marcador de consulta: ${consultToken("t-1", "a1")}`),
    "contrato leva o marcador da consulta",
  );
  const huge = oracleContract({ ...contractInput, question: "q".repeat(5000), askContext: "c".repeat(5000) });
  const bigger = oracleContract({ ...contractInput, question: "q".repeat(50_000), askContext: "c".repeat(50_000) });
  assert.equal(bigger.length, huge.length, "o teto não cresce com a entrada");
  assert.ok(huge.length < 2200, `contrato com ${huge.length} caracteres`);
});

test("parecer não-answered nunca vira orientação: o envio com ask_id é recusado", async () => {
  const { h, t } = await startTask();
  assert.equal(latestAsk(t.task_dir), null);
  const askId = await askWorker(h, t);
  const text = settleOracleVerdict({
    taskId: t.task_id,
    taskDir: t.task_dir,
    askId,
    raw: JSON.stringify({ verdict: "contradictory", reason: "spec e código divergem" }),
  });
  assert.match(text, /não autoriza resposta/);
  await assert.rejects(h.orch.send(t.task_id, "use X", askId), /sem parecer do Oracle que autorize/);
  assert.equal(h.herdr.opsOf("prompt").length, 0, "nada foi enviado ao worker");
  assert.equal(h.orch.get(t.task_id).status, "running");
});

test("uma consulta por pergunta: segundo parecer é recusado e falha de formato encerra a consulta", async () => {
  const { h, t } = await startTask();
  const askId = await askWorker(h, t);
  const diagnosis = settleOracleVerdict({ taskId: t.task_id, taskDir: t.task_dir, askId, raw: "texto solto" });
  assert.match(diagnosis, /não entregou parecer válido/);
  assert.match(diagnosis, /não consulte de novo/);
  assert.throws(
    () => settleOracleVerdict({ taskId: t.task_id, taskDir: t.task_dir, askId, raw: answered() }),
    /já há parecer/,
    "o ciclo não reabre depois de falha",
  );
  await assert.rejects(h.orch.send(t.task_id, "use X", askId), /sem parecer do Oracle/);
});

test("parecer de pergunta que não é a atual é recusado", async () => {
  const { h, t } = await startTask();
  await askWorker(h, t);
  assert.throws(
    () => settleOracleVerdict({ taskId: t.task_id, taskDir: t.task_dir, askId: "velha", raw: answered() }),
    /não é a atual/,
  );
});

test("sequência ponta a ponta: worker pergunta, Oracle responde, orquestrador envia correlacionado, worker conclui", async () => {
  const { h, t } = await startTask();
  await asWorker(t, async ({ tools, startTurn, endTurn }) => {
    await tools.orch_ask.execute("c1", {
      kind: "operacional",
      question: "Reutilizar qual contrato?",
      context: "encontrei dois helpers",
    });
    await endTurn();

    const ev = await h.orch.noticeFor(t.task_id);
    assert.ok(ev, "o orquestrador recebe a pergunta");
    assert.equal(ev.kind, "ask");
    const askId = ev.ask_id ?? "";
    assert.ok(askId.length > 0, "o aviso traz o id da pergunta");
    const contract = oracleContract({
      ...contractInput,
      taskId: t.task_id,
      askId,
      askContext: ev.result ?? "",
      projectPath: h.project,
      visionPath: `${h.project}/VISION.md`,
    });
    const msg = askMessageFor(ev, contract);
    assert.ok(msg.includes(contract), "a mensagem leva o contrato, e não a conversa do worker");
    assert.ok(msg.includes(`orch_ask_verdict(task_id="${t.task_id}", ask_id="${askId}"`));

    const next = settleOracleVerdict({ taskId: t.task_id, taskDir: t.task_dir, askId, raw: answered() });
    assert.match(next, /orch_send\(task_id=.*ask_id=/);
    await h.orch.send(t.task_id, "use o helper de src/shared/x.ts", askId);
    const prompts = h.herdr.opsOf("prompt");
    assert.equal(prompts.length, 1);
    assert.equal(
      (prompts[0].args as { text: string }).text,
      `[resposta à pergunta ${askId}] use o helper de src/shared/x.ts`,
    );
    assert.equal(h.orch.get(t.task_id).status, "running", "a tarefa segue running");

    await assert.rejects(h.orch.send(t.task_id, "outra", askId), /já foi respondida/);

    await reportDone({ tools, startTurn, endTurn }, h.orch, t.task_id, "PR aberta");
  });
});

// keep: combina as duas camadas: pendência da #232 (sem ask_id é recusado) e parecer answered do Oracle (sem ele, nada segue).
test("pergunta pendente com parecer não-answered: sem ask_id e com ask_id, nada vai ao worker", async () => {
  const { h, t } = await startTask();
  const askId = await askWorker(h, t);
  settleOracleVerdict({
    taskId: t.task_id,
    taskDir: t.task_dir,
    askId,
    raw: JSON.stringify({ verdict: "inconclusive", reason: "a spec não diz" }),
  });
  await assert.rejects(h.orch.send(t.task_id, "sem id"), /há pergunta pendente/);
  await assert.rejects(h.orch.send(t.task_id, "com id", askId), /sem parecer do Oracle que autorize/);
  assert.equal(h.herdr.opsOf("prompt").length, 0);
  assert.equal(h.orch.get(t.task_id).pending_ask?.id, askId, "a pergunta segue pendente");
});

// keep: combina as duas camadas: falha de envio mantém a pergunta pendente com motivo, e a retentativa com o mesmo parecer entrega uma vez.
test("parecer answered + falha de envio: retentativa entrega uma vez e replay é recusado", async () => {
  const { h, t } = await startTask();
  const askId = await askWorker(h, t);
  settleOracleVerdict({ taskId: t.task_id, taskDir: t.task_dir, askId, raw: answered() });
  let failOnce = true;
  const original = h.herdr.prompt.bind(h.herdr);
  h.herdr.prompt = async (target: string, text: string) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("painel ocupado");
    }
    return original(target, text);
  };
  await assert.rejects(h.orch.send(t.task_id, "use X", askId), /painel ocupado/);
  const pending = h.orch.get(t.task_id).pending_ask;
  assert.equal(pending?.id, askId, "a pergunta segue pendente");
  assert.match(pending?.send_error ?? "", /painel ocupado/);
  await h.orch.send(t.task_id, "use X", askId);
  const sent = h.herdr.opsOf("prompt");
  assert.equal(sent.length, 1, "uma única entrega ao worker");
  assert.equal((sent[0].args as { text: string }).text, `[resposta à pergunta ${askId}] use X`);
  await assert.rejects(h.orch.send(t.task_id, "use X", askId), /já foi respondida/);
  assert.equal(h.orch.get(t.task_id).pending_ask ?? null, null);
});

test("E2E: parecer forjado é recusado; só a saída capturada de uma consulta lançada libera a resposta", async () => {
  const { h, t } = await startTask();
  const askId = await askWorker(h, t);
  const captures = new OracleCaptures();
  const task = oracleContract({
    ...contractInput,
    taskId: t.task_id,
    askId,
    projectPath: h.project,
    visionPath: `${h.project}/VISION.md`,
  });
  const token = consultToken(t.task_id, askId);

  assert.throws(
    () => settleRaw({ taskId: t.task_id, taskDir: t.task_dir, askId, raw: answered(), capture: captures.get(token) }),
    /sem consulta registrada/,
  );
  await assert.rejects(h.orch.send(t.task_id, "use X", askId), /sem parecer do Oracle que autorize/);
  assert.equal(h.herdr.opsOf("prompt").length, 0);

  const inconclusive = JSON.stringify({ verdict: "inconclusive", reason: "a spec não diz" });
  captures.noteCall("call-1", { agent: ORACLE_AGENT, task, model: "m" });
  captures.noteResult("call-1", inconclusive, false);
  assert.throws(
    () => settleRaw({ taskId: t.task_id, taskDir: t.task_dir, askId, raw: answered(), capture: captures.get(token) }),
    /não confere com a saída/,
  );
  await assert.rejects(h.orch.send(t.task_id, "use X", askId), /sem parecer do Oracle que autorize/);

  settleRaw({ taskId: t.task_id, taskDir: t.task_dir, askId, raw: inconclusive, capture: captures.get(token) });
  await assert.rejects(h.orch.send(t.task_id, "use X", askId), /sem parecer do Oracle que autorize/);
  assert.equal(h.herdr.opsOf("prompt").length, 0);
});

test("E2E: consulta lançada com marcador -> parecer answered capturado -> resposta entregue", async () => {
  const { h, t } = await startTask();
  const askId = await askWorker(h, t);
  const captures = new OracleCaptures();
  const task = oracleContract({
    ...contractInput,
    taskId: t.task_id,
    askId,
    projectPath: h.project,
    visionPath: `${h.project}/VISION.md`,
  });
  captures.noteCall("call-ok", { agent: ORACLE_AGENT, task, model: "m" });
  captures.noteResult("call-ok", answered(), false);
  const text = settleRaw({
    taskId: t.task_id,
    taskDir: t.task_dir,
    askId,
    raw: answered(),
    capture: captures.get(consultToken(t.task_id, askId)),
  });
  assert.match(text, /Parecer answered registrado/);
  await h.orch.send(t.task_id, "use o helper", askId);
  const sent = h.herdr.opsOf("prompt");
  assert.equal(sent.length, 1);
  assert.equal((sent[0].args as { text: string }).text, `[resposta à pergunta ${askId}] use o helper`);
});
