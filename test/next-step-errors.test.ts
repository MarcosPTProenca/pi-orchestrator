import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, writeReport } from "./fakes.ts";

// Issue #132: a recusa precisa dizer a ferramenta certa a usar em seguida, não só o que não pode ser feito.

test("relançar tarefa done recusa e aponta orch_send ou orch_delegate (passos 1-3 da issue)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
  await h.orch.refresh(t.task_id);
  await assert.rejects(h.orch.relaunch(t.task_id), (err: Error) => {
    assert.match(err.message, /só relança tarefa falha \(status: done\)/);
    assert.match(err.message, /orch_send/);
    assert.match(err.message, /orch_delegate/);
    return true;
  });
  assert.equal(h.orch.get(t.task_id).status, "done", "a recusa não muda o estado");
});

test("responder tarefa running recusa e aponta orch_send (passo 4 da issue)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  await assert.rejects(h.orch.answer(t.task_id, "oi"), (err: Error) => {
    assert.match(err.message, /não está bloqueada \(status: running\)/);
    assert.match(err.message, /orch_send/);
    assert.doesNotMatch(err.message, /orch_answer/);
    return true;
  });
  assert.equal(h.herdr.opsOf("prompt").length, 0, "nada foi enviado ao painel");
});

test("responder tarefa done recusa e aponta orch_send, não orch_answer", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
  await h.orch.refresh(t.task_id);
  await assert.rejects(h.orch.answer(t.task_id, "oi"), (err: Error) => {
    assert.match(err.message, /não está bloqueada \(status: done\)/);
    assert.match(err.message, /orch_send/);
    return true;
  });
});

test("enviar mensagem a tarefa failed recusa e aponta orch_relaunch", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "failed", result: "erro" });
  await h.orch.refresh(t.task_id);
  await assert.rejects(h.orch.send(t.task_id, "oi"), (err: Error) => {
    assert.match(err.message, /não aceita mensagem \(status: failed\)/);
    assert.match(err.message, /orch_relaunch/);
    return true;
  });
});
