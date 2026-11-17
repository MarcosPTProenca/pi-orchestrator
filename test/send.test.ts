import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, writeReport } from "./fakes.ts";

async function running(h: ReturnType<typeof makeHarness>) {
  return h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
}

test("mensagem a worker em execução segue para o painel e o status não muda", async () => {
  const h = makeHarness();
  const t = await running(h);
  await h.orch.send(t.task_id, "o escopo mudou: use a branch fm/x");
  const prompts = h.herdr.opsOf("prompt");
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].args, { target: t.pane_id, text: "o escopo mudou: use a branch fm/x" });
  assert.equal(h.orch.get(t.task_id).status, "running");
});

test("tarefa ainda subindo ou terminal recusa, sem enviar nada", async () => {
  const h = makeHarness();
  const t = await running(h);
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" });
  await h.orch.refresh(t.task_id);
  await assert.rejects(h.orch.send(t.task_id, "oi"), /status: done/);
  assert.equal(h.herdr.opsOf("prompt").length, 0);
});

test("painel trocado recusa e não envia", async () => {
  const h = makeHarness();
  const t = await running(h);
  h.herdr.panesList = h.herdr.panesList.map((p) => (p.pane_id === t.pane_id ? { ...p, terminal_id: "outro" } : p));
  await assert.rejects(h.orch.send(t.task_id, "oi"), /trocou de agente/);
  assert.equal(h.herdr.opsOf("prompt").length, 0);
});

test("texto vazio recusa", async () => {
  const h = makeHarness();
  const t = await running(h);
  await assert.rejects(h.orch.send(t.task_id, "   "), /mensagem vazia/);
});

test("worker bloqueado: envio vira resposta (reabre a tarefa)", async () => {
  const h = makeHarness();
  const t = await running(h);
  writeReport(t.task_dir, t.task_id, { status: "blocked", question: "A ou B?" }, "1");
  await h.orch.refresh(t.task_id);
  await h.orch.send(t.task_id, "use A");
  assert.equal(h.orch.get(t.task_id).status, "running");
  assert.equal(h.herdr.opsOf("prompt")[0].args && (h.herdr.opsOf("prompt")[0].args as { text: string }).text, "use A");
});
