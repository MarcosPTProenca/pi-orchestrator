import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension, { ASK_BLOCK_REASON } from "../src/worker-ext.ts";

function loadWorker(): Record<string, Function> {
  const handlers: Record<string, Function> = {};
  workerExtension({
    on: (name: string, f: Function) => {
      handlers[name] = f;
    },
    registerTool: () => {},
    registerEntryRenderer: () => {},
    appendEntry: () => {},
  } as never);
  return handlers;
}

test("worker bloqueia AskUserQuestion e manda usar orch_report blocked", () => {
  const prev = { role: process.env.PI_ORCH_ROLE, id: process.env.PI_ORCH_TASK_ID, dir: process.env.PI_ORCH_TASK_DIR };
  const dir = mkdtempSync(join(tmpdir(), "orch-ask-"));
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = "t-ask1";
    process.env.PI_ORCH_TASK_DIR = dir;
    const h = loadWorker();
    const r = h.tool_call({ toolName: "AskUserQuestion", input: {} });
    assert.deepEqual(r, { block: true, reason: ASK_BLOCK_REASON });
    assert.match(ASK_BLOCK_REASON, /orch_report com status blocked/);
    assert.equal(h.tool_call({ toolName: "bash", input: {} }), undefined, "outras ferramentas não são afetadas");
  } finally {
    for (const [k, v] of [
      ["PI_ORCH_ROLE", prev.role],
      ["PI_ORCH_TASK_ID", prev.id],
      ["PI_ORCH_TASK_DIR", prev.dir],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fora do papel worker a extensão não registra o bloqueio", () => {
  const prev = process.env.PI_ORCH_ROLE;
  try {
    delete process.env.PI_ORCH_ROLE;
    assert.equal(loadWorker().tool_call, undefined);
  } finally {
    if (prev !== undefined) process.env.PI_ORCH_ROLE = prev;
  }
});
