import { test } from "node:test";
import assert from "node:assert/strict";
import { capError, maxActiveFrom } from "../src/cap.ts";
import { FixQueue } from "../src/queue.ts";
import { makeHarness } from "./fakes.ts";

test("teto padrão é 6 e pode ser trocado por PI_ORCH_MAX_ACTIVE; valor inválido cai no padrão", () => {
  assert.equal(maxActiveFrom(undefined), 6);
  assert.equal(maxActiveFrom("10"), 10);
  assert.equal(maxActiveFrom("0"), 6);
  assert.equal(maxActiveFrom("abc"), 6);
  assert.equal(maxActiveFrom("999"), 6);
});

test("capError recusa quando o lote estoura, dizendo ativos, teto e o que fazer", () => {
  assert.equal(capError(4, 2, 6), null);
  const msg = capError(5, 3, 6);
  assert.ok(msg);
  assert.match(msg!, /5 ativos/);
  assert.match(msg!, /teto é 6/);
  assert.match(msg!, /[Aa]guarde|cancele|PI_ORCH_MAX_ACTIVE/);
});

test("orchestrator conta só tarefas ativas (starting, running, blocked)", async () => {
  const h = makeHarness();
  const a = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  await h.orch.delegate({ project_path: h.project, role: "b", request: "x", objective: "y", mode: "report" });
  assert.equal(h.orch.activeCount(), 2);
  await h.orch.cancel(a.task_id);
  assert.equal(h.orch.activeCount(), 1);
});

test("fila só inicia item quando canStart permite; liberar vaga e pump retoma", async () => {
  let room = 1;
  const started: string[] = [];
  const q = new FixQueue<string>(3, async (item) => {
    started.push(item);
    return `t-${item}`;
  }, { canStart: () => started.length < room });
  await q.enqueue(["a", "b", "c"]);
  assert.deepEqual(started, ["a"]);
  room = 2;
  await q.pump();
  assert.deepEqual(started, ["a", "b"]);
  assert.equal(q.pendingCount, 1);
});
