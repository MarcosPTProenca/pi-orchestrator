import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "../src/worker-ext.ts";

test("o pedido completo da tarefa aparece na sessão do trabalhador", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-visible-"));
  const previous = { ...process.env };
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = "t-visible";
    process.env.PI_ORCH_TASK_DIR = dir;
    writeFileSync(join(dir, "brief.md"), "## Pedido do usuário\nCorrija a revisão");
    const handlers: Record<string, Function> = {};
    workerExtension({
      on: (name: string, fn: Function) => {
        handlers[name] = fn;
      },
      registerTool: () => {},
    } as never);
    const result = handlers.before_agent_start({ systemPrompt: "base" });
    assert.equal(result.message.display, true);
    assert.match(result.message.content, /Corrija a revisão/);
  } finally {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
