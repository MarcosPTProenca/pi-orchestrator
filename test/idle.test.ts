import { test } from "node:test";
import assert from "node:assert/strict";
import { idleSurfaces, type LiveSurfaces } from "../src/idle.ts";
import { parseTabIds } from "../src/herdr.ts";
import type { TaskRecord } from "../src/contract.ts";

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    task_id: "t-x",
    project_id: "p",
    tab_id: "w1:t1",
    pane_id: "w1:t1-1",
    terminal_id: "term-1",
    status: "done",
    notified: true,
    updated_at: "2026-11-18T10:00:00.000Z",
    ...over,
  } as TaskRecord;
}

/** Herdr em que a tab e o pane/terminal da tarefa ainda existem. */
function liveFor(...tasks: TaskRecord[]): LiveSurfaces {
  return {
    tabIds: new Set(tasks.map((t) => t.tab_id)),
    panes: tasks.map((t) => ({ pane_id: t.pane_id, terminal_id: t.terminal_id, cwd: null, agent: null, agent_status: null })),
  };
}

test("done e já entregue com tab confirmada no Herdr é candidata a fechar", () => {
  const t = task({ task_id: "t-a" });
  assert.deepEqual(idleSurfaces([t], liveFor(t)).map((s) => s.task_id), ["t-a"]);
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
  assert.deepEqual(idleSurfaces(tasks, liveFor(...tasks)), []);
});

test("sem tab registrada não há superfície a fechar", () => {
  const t = task({ tab_id: "" });
  assert.deepEqual(idleSurfaces([t], liveFor(t)), []);
});

test("tab registrada que o Herdr não lista mais não é lembrada", () => {
  const t = task({ task_id: "t-fechada" });
  assert.deepEqual(idleSurfaces([t], { tabIds: new Set(), panes: liveFor(t).panes }), []);
});

test("tab reutilizada por outro terminal não conta como da tarefa", () => {
  const t = task({ task_id: "t-reusada", terminal_id: "term-antigo" });
  const live = { tabIds: new Set([t.tab_id]), panes: [{ pane_id: t.pane_id, terminal_id: "term-novo", cwd: null, agent: null, agent_status: null }] };
  assert.deepEqual(idleSurfaces([t], live), []);
});

test("ordena pela data de atualização, a mais antiga primeiro, e marca workspace próprio", () => {
  const nova = task({ task_id: "t-nova", updated_at: "2026-11-18T12:00:00.000Z" });
  const velha = task({ task_id: "t-velha", updated_at: "2026-11-16T09:00:00.000Z", projected: true, tab_id: "w2:t1", pane_id: "w2:t1-1", terminal_id: "term-2" });
  const out = idleSurfaces([nova, velha], liveFor(nova, velha));
  assert.deepEqual(out.map((s) => [s.task_id, s.projected]), [["t-velha", true], ["t-nova", false]]);
});

test("parseTabIds lê os tab_id de tab list", () => {
  const json = { id: "cli:tab:list", result: { tabs: [{ tab_id: "w1:t1" }, { tab_id: "w1:t2" }], type: "tab_list" } };
  assert.deepEqual([...parseTabIds(json)].sort(), ["w1:t1", "w1:t2"]);
});

test("parseTabIds rejeita resposta sem tabs", () => {
  assert.throws(() => parseTabIds({ result: {} }), /sem tabs/);
});
