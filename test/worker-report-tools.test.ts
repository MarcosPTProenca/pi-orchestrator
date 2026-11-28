import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "../src/worker/worker-ext.ts";

test("orch_report registra as ferramentas MCP liberadas pela política da tarefa", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-report-tools-"));
  const previous = {
    role: process.env.PI_ORCH_ROLE,
    taskId: process.env.PI_ORCH_TASK_ID,
    taskDir: process.env.PI_ORCH_TASK_DIR,
    policy: process.env.PI_ORCH_TOOL_POLICY,
  };
  const tools: Record<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = {};
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = "t-report-tools";
    process.env.PI_ORCH_TASK_DIR = dir;
    process.env.PI_ORCH_TOOL_POLICY = JSON.stringify({
      mode: "report",
      allowed: ["read", "bash", "mcp__plane__*"],
    });
    workerExtension({
      on: () => {},
      registerTool: (tool: {
        name: string;
        execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
      }) => {
        tools[tool.name] = tool;
      },
      registerEntryRenderer: () => {},
      appendEntry: () => {},
    } as never);

    await tools.orch_report.execute("call-1", { status: "done", result: "ok" });
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as {
      released_tools?: string[];
    };
    assert.deepEqual(report.released_tools, ["mcp__plane__*"]);
  } finally {
    for (const [key, value] of Object.entries({
      PI_ORCH_ROLE: previous.role,
      PI_ORCH_TASK_ID: previous.taskId,
      PI_ORCH_TASK_DIR: previous.taskDir,
      PI_ORCH_TOOL_POLICY: previous.policy,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
