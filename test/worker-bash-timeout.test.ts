import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension, { WORKER_BASH_TIMEOUT_S } from "../src/worker/worker-ext.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

// Captura os handlers registrados; chamadas não usadas viram no-op.
function fakePi(handlers: Record<string, Handler[]>) {
  const target: Record<string, unknown> = {
    on: (name: string, h: Handler) => {
      (handlers[name] ??= []).push(h);
    },
  };
  return new Proxy(target, {
    get: (t, prop: string) => (prop in t ? t[prop] : () => undefined),
  }) as unknown as Parameters<typeof workerExtension>[0];
}

function withWorkerEnv(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "orch-bash-timeout-"));
  const prev = {
    role: process.env.PI_ORCH_ROLE,
    id: process.env.PI_ORCH_TASK_ID,
    dir: process.env.PI_ORCH_TASK_DIR,
  };
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = "t-bash-timeout";
    process.env.PI_ORCH_TASK_DIR = dir;
    fn(dir);
  } finally {
    for (const [k, v] of Object.entries({
      PI_ORCH_ROLE: prev.role,
      PI_ORCH_TASK_ID: prev.id,
      PI_ORCH_TASK_DIR: prev.dir,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function toolCallHandler(handlers: Record<string, Handler[]>): Handler {
  const h = handlers.tool_call?.[0];
  assert.ok(h, "tool_call handler registrado");
  return h;
}

test("bash do worker sem timeout recebe o limite padrão", () => {
  withWorkerEnv(() => {
    const handlers: Record<string, Handler[]> = {};
    workerExtension(fakePi(handlers));
    const input: { command: string; timeout?: number } = { command: "echo ok" };
    toolCallHandler(handlers)({ toolName: "bash", input });
    assert.equal(input.timeout, WORKER_BASH_TIMEOUT_S);
  });
});

test("bash com timeout explícito mantém o valor do modelo", () => {
  withWorkerEnv(() => {
    const handlers: Record<string, Handler[]> = {};
    workerExtension(fakePi(handlers));
    const input: { command: string; timeout?: number } = { command: "npm test", timeout: 30 };
    toolCallHandler(handlers)({ toolName: "bash", input });
    assert.equal(input.timeout, 30);
  });
});

test("ferramenta que não é bash não recebe timeout", () => {
  withWorkerEnv(() => {
    const handlers: Record<string, Handler[]> = {};
    workerExtension(fakePi(handlers));
    const input: { path: string; timeout?: number } = { path: "a.txt" };
    toolCallHandler(handlers)({ toolName: "read", input });
    assert.equal(input.timeout, undefined);
  });
});
