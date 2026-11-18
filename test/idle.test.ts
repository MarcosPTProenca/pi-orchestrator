import { test } from "node:test";
import assert from "node:assert/strict";
import { idleSurfaces } from "../src/idle.ts";
import type { TaskRecord } from "../src/contract.ts";

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    task_id: "t-x",
    project_id: "p",
    tab_id: "w1:t1",
    status: "done",
    notified: true,
    updated_at: "2026-11-18T10:00:00.000Z",
    ...over,
  } as TaskRecord;
}

test("done e já entregue com tab registrada é candidata a fechar", () => {
  const out = idleSurfaces([task({ task_id: "t-a" })]);
  assert.deepEqual(out.map((s) => s.task_id), ["t-a"]);
});

test("tarefas que ainda pedem atenção ficam de fora", () => {
  const tasks = [
    task({ task_id: "t-running", status: "running", notified: false }),
    task({ task_id: "t-blocked", status: "blocked", notified: false }),
    task({ task_id: "t-failed", status: "failed" }),
    task({ task_id: "t-lost", status: "lost" }),
    task({ task_id: "t-cancelled", status: "cancelled" }),
    task({ task_id: "t-unread", notified: false }),
  ];
  assert.deepEqual(idleSurfaces(tasks), []);
});

test("sem tab registrada não há superfície a fechar", () => {
  assert.deepEqual(idleSurfaces([task({ tab_id: "" })]), []);
});

test("ordena pela data de atualização, a mais antiga primeiro, e marca workspace próprio", () => {
  const out = idleSurfaces([
    task({ task_id: "t-nova", updated_at: "2026-11-18T12:00:00.000Z" }),
    task({ task_id: "t-velha", updated_at: "2026-11-16T09:00:00.000Z", projected: true }),
  ]);
  assert.deepEqual(out.map((s) => [s.task_id, s.projected]), [["t-velha", true], ["t-nova", false]]);
});
