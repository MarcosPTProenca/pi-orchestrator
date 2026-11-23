import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "../src/worker/worker-ext.ts";

test("o pedido completo da tarefa aparece na sessão do trabalhador (entrada de exibição)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-visible-"));
  const previous = { ...process.env };
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = "t-visible";
    process.env.PI_ORCH_TASK_DIR = dir;
    writeFileSync(join(dir, "brief.md"), "## Pedido do usuário\nCorrija a revisão");
    type Fn = (...args: unknown[]) => unknown;
    const handlers: Record<string, Fn> = {};
    const appended: { customType: string; data: { content: string } }[] = [];
    let renderer: ((entry: unknown) => { render: (w: number) => string[] }) | undefined;
    workerExtension({
      on: (name: string, fn: Fn) => {
        handlers[name] = fn;
      },
      registerTool: () => {},
      registerEntryRenderer: (_type: string, fn: typeof renderer) => {
        renderer = fn;
      },
      appendEntry: (customType: string, data: { content: string }) => appended.push({ customType, data }),
    } as never);
    const result = handlers.before_agent_start?.({ systemPrompt: "base" }, undefined) as
      { message?: unknown } | undefined;
    assert.equal(result?.message, undefined);
    assert.equal(appended[0]?.customType, "orch-brief");
    assert.match(appended[0]?.data.content ?? "", /Corrija a revisão/);
    const rendered = renderer?.({ data: appended[0]?.data })?.render(80).join("\n") ?? "";
    assert.match(rendered, /Corrija a revisão/);
  } finally {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
