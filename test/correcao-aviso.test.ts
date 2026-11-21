import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { modelMessageFor } from "../src/index.ts";
import { Store } from "../src/store.ts";
import { makeHarness, writeReport } from "./fakes.ts";

test("relatório válido que chega depois de 'lost' traz a correção do aviso anterior (#57)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  new Store(join(h.stateDir, "state.json")).mutate((s) => {
    s.tasks[t.task_id].status = "lost";
    s.tasks[t.task_id].error = "pane não existe mais";
    s.tasks[t.task_id].notified = false;
  });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "entregue" }, "9");
  const e = await h.orch.refresh(t.task_id);
  assert.ok(e, "o relatório válido gera evento");
  assert.equal(e.status, "done");
  assert.match(
    e.correction ?? "",
    /antes marcada como lost \(pane não existe mais\); o relatório válido chegou depois e prevalece/,
  );
  assert.match(modelMessageFor(e), /Correção de aviso anterior: antes marcada como lost/);
});

test("relatório normal, sem reabertura, não traz correção", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "ok" }, "1");
  const e = await h.orch.refresh(t.task_id);
  assert.ok(e);
  assert.equal(e.correction ?? null, null);
  assert.doesNotMatch(modelMessageFor(e), /Correção de aviso anterior/);
});
