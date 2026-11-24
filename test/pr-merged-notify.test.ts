import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { isPrWatched } from "../src/orchestrator/pr-watch.ts";
import { Store } from "../src/shared/store.ts";
import { makeHarness, writeReport } from "./fakes.ts";

const PR_URL = "https://github.com/o/r/pull/180";

test("PR mergeada notifica uma vez mesmo com vários ciclos de polling (#180)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" }, "1");
  await h.orch.refresh(t.task_id);
  // Entrega do relatório já feita ao usuário (notified) e PR como fonte da tarefa.
  new Store(join(h.stateDir, "state.json")).mutate((s) => {
    s.tasks[t.task_id].source = PR_URL;
    s.tasks[t.task_id].notified = true;
  });

  // Cada ciclo replica o filtro de checkIdle; o ramo "merged" de checkPr é closeMerged.
  const notifications: string[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const x of h.orch.owned()) {
      if (!isPrWatched(x)) continue;
      await h.orch.closeMerged(x.task_id);
      notifications.push(x.task_id);
    }
  }

  assert.deepEqual(notifications, [t.task_id], "exatamente 1 notificação de merge");
  assert.equal(isPrWatched(h.orch.get(t.task_id)), false, "tarefa sai da lista observada após o merge");
  assert.equal(h.orch.get(t.task_id).tab_id, "", "tab_id limpo depois do merge");
  assert.equal(h.orch.get(t.task_id).pane_id, t.pane_id, "pane preservada");
});

test("closeMerged fecha a aba da PR mergeada antes de limpar tab_id", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" }, "1");
  await h.orch.refresh(t.task_id);
  const outcome = await h.orch.closeMerged(t.task_id);
  assert.equal(outcome.closed, true);
  assert.equal(h.herdr.opsOf("closeTab").at(-1)?.args, t.tab_id);
});
