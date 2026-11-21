import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarness, writeReport } from "./fakes.ts";

test("coletas simultâneas do mesmo relatório geram um único evento (#57)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeReport(t.task_dir, t.task_id, { status: "done", result: "pronto" }, "2");
  const results = await Promise.all([h.orch.refresh(t.task_id), h.orch.refresh(t.task_id), h.orch.refresh(t.task_id)]);
  assert.equal(results.filter((r) => r !== null).length, 1, "só uma coleta entrega o evento");
  assert.equal(h.orch.get(t.task_id).status, "done");
});

test("relatório válido que chega durante coleta com relatório inválido não vira falha (#57)", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  writeFileSync(join(t.task_dir, "report.json"), JSON.stringify({ status: "done", result: "sem id" }));
  const [a, b] = await Promise.all([
    h.orch.refresh(t.task_id),
    (async () => {
      writeReport(t.task_dir, t.task_id, { status: "done", result: "corrigido" }, "2");
      return h.orch.refresh(t.task_id);
    })(),
  ]);
  const final = h.orch.get(t.task_id);
  assert.notEqual(final.status, "failed", `não pode terminar falha: ${final.error ?? ""}`);
  assert.equal(final.status, "done");
  assert.ok([a, b].some((r) => r !== null));
});
