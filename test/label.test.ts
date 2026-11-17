import { test } from "node:test";
import assert from "node:assert/strict";
import { workerAgentName, workerTabName } from "../src/label.ts";

test("tab do worker usa worker-<role>-<id>, com o mesmo id do pane", () => {
  const tab = workerTabName("a", "e01fd3c6");
  assert.equal(tab, "worker-a-e01fd3");
  assert.match(tab, /^worker-/);
  assert.ok(workerAgentName("/x/pi-orchestrator", "e01fd3c6").endsWith("-e01fd3"));
  assert.ok(tab.endsWith("-e01fd3"));
});

test("tab do worker fica dentro do limite de 32 caracteres", () => {
  const tab = workerTabName("a-role-muito-longo-que-passa-do-limite", "e01fd3c6");
  assert.ok(tab.length <= 32, `tamanho ${tab.length}`);
  assert.match(tab, /-e01fd3$/);
});
