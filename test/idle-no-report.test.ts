import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, writeReport, type Harness } from "./fakes.ts";

const MIN = 60_000;

async function delegated(h: Harness) {
  return h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
}

// keep: avança o relógio, ajusta o estado do pane e reconcilia a tarefa, como o sweep periódico faz.
async function tick(h: Harness, taskId: string, paneId: string, agentStatus: string, minutes: number) {
  h.clock.ms += minutes * MIN;
  h.herdr.panesList = h.herdr.panesList.map((p) =>
    p.pane_id === paneId ? { ...p, agent: "pi", agent_status: agentStatus } : p,
  );
  return h.orch.refresh(taskId);
}

test("worker encerra o turno sem orch_report e o pane fica ocioso: falha com motivo após o limite (#227)", async () => {
  const h = makeHarness();
  const t = await delegated(h);
  await tick(h, t.task_id, t.pane_id, "idle", 0);
  await tick(h, t.task_id, t.pane_id, "idle", 9);
  assert.equal(h.orch.get(t.task_id).status, "running", "abaixo do limite ainda não falha");

  const ev = await tick(h, t.task_id, t.pane_id, "idle", 2);
  const after = h.orch.get(t.task_id);
  assert.equal(after.status, "failed");
  assert.match(after.error ?? "", /ocioso/);
  assert.match(after.error ?? "", /orch_report/);
  assert.ok(ev, "a falha gera evento para o orquestrador");
});

test("pane que volta a trabalhar zera o relógio ocioso", async () => {
  const h = makeHarness();
  const t = await delegated(h);
  await tick(h, t.task_id, t.pane_id, "idle", 0);
  await tick(h, t.task_id, t.pane_id, "working", 8);
  await tick(h, t.task_id, t.pane_id, "idle", 8);
  assert.equal(h.orch.get(t.task_id).status, "running");
});

test("pane trabalhando nunca falha por ociosidade", async () => {
  const h = makeHarness();
  const t = await delegated(h);
  await tick(h, t.task_id, t.pane_id, "working", 60);
  assert.equal(h.orch.get(t.task_id).status, "running");
});

test("relatório que chega depois da falha por ociosidade reabre a tarefa", async () => {
  const h = makeHarness();
  const t = await delegated(h);
  await tick(h, t.task_id, t.pane_id, "idle", 0);
  await tick(h, t.task_id, t.pane_id, "idle", 11);
  assert.equal(h.orch.get(t.task_id).status, "failed");

  writeReport(t.task_dir, t.task_id, { status: "done", result: "entregue tarde" }, "late");
  await h.orch.refresh(t.task_id);
  assert.equal(h.orch.get(t.task_id).status, "done");
  assert.equal(h.orch.get(t.task_id).result, "entregue tarde");
});
