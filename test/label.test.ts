import { test } from "node:test";
import assert from "node:assert/strict";
import { ORCHESTRATOR_PANE_LABEL, workerAgentName, workerTabName } from "../src/shared/label.ts";

test("pane do orquestrador tem rótulo visual fixo e seguro para o Herdr", () => {
  assert.equal(ORCHESTRATOR_PANE_LABEL, "PI FACTORY · ORCHESTRATOR");
  assert.ok(ORCHESTRATOR_PANE_LABEL.length <= 32, `tamanho ${ORCHESTRATOR_PANE_LABEL.length}`);
  assert.doesNotMatch(ORCHESTRATOR_PANE_LABEL, /[\u0000-\u001f\u007f]/, "sem caracteres de controle");
});

test("tab do worker usa worker-<role>-<id>, com o mesmo id do pane", () => {
  const tab = workerTabName("a", "e01fd3c6");
  assert.equal(tab, "worker-a-e01fd3");
  assert.match(tab, /^worker-/);
  assert.ok(workerAgentName("/x/pi-orchestrator", "e01fd3c6").endsWith("-e01fd3"));
  assert.ok(tab.endsWith("-e01fd3"));
});

test("título do worker tem fallback seguro sem ticket, com Unicode ou malformado", () => {
  assert.equal(workerTabName("", "e01fd3c6"), "worker-tarefa-e01fd3");
  assert.equal(workerTabName("  §§ ção ??? ", "e01fd3c6"), "worker-cao-e01fd3");
  assert.equal(workerTabName("\u0007\n\t", "e01fd3c6"), "worker-tarefa-e01fd3");
  assert.equal(workerTabName("a", ""), "worker-a-x");
});

test("tab do worker fica dentro do limite de 32 caracteres", () => {
  const tab = workerTabName("a-role-muito-longo-que-passa-do-limite", "e01fd3c6");
  assert.ok(tab.length <= 32, `tamanho ${tab.length}`);
  assert.match(tab, /-e01fd3$/);
});
