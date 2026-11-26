import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./fakes.ts";
import { asWorker, reportDone } from "./worker-harness.ts";
import { askMessageFor } from "../src/orchestrator/messages.ts";
import { oracleContract, parseOracleAnswer, settleOracleVerdict } from "../src/orchestrator/oracle-ask.ts";
import { latestAsk } from "../src/shared/ask.ts";

const answered = (answer = "use o helper de src/shared/x.ts") =>
  JSON.stringify({ verdict: "answered", answer, reason: "spec cita o helper", uncertainty: "" });

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
    // 1. worker pergunta e encerra o turno sem fechar a tarefa
    await tools.orch_ask.execute("c1", {
      kind: "operacional",
      question: "Reutilizar qual contrato?",
      context: "encontrei dois helpers",
    });
    await endTurn();

    // 2. orquestrador recebe o aviso com id e monta a mensagem com o contrato do Oracle
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

    // 3. Oracle (simulado) responde answered; orquestrador valida e envia com ask_id
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

    // 4. a mesma pergunta não é respondida duas vezes
    await assert.rejects(h.orch.send(t.task_id, "outra", askId), /não está pendente/);

    // 5. worker continua e conclui com relatório válido (gate final)
    await reportDone({ tools, startTurn, endTurn }, h.orch, t.task_id, "PR aberta");
  });
});
