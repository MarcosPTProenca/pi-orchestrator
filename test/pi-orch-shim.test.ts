import { test } from "node:test";
import assert from "node:assert/strict";
import orchestratorExtension from "../src/orchestrator/extension.ts";
import piOrchShim from "../.pi/extensions/pi-orch.ts";

test("extensão auto-discovered (.pi/extensions/pi-orch.ts) reexporta exatamente src/orchestrator/extension.ts", () => {
  // keep: só garante que o shim não diverge por engano; a lógica em si já tem testes próprios.
  assert.equal(piOrchShim, orchestratorExtension);
});
