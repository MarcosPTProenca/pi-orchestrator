import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "../src/worker/worker-ext.ts";
import { workerSessionFile } from "../src/shared/session-file.ts";

test("o worker grava o caminho da própria sessão Pi na pasta da tarefa", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-sess-ptr-"));
  const previous = { ...process.env };
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = "t-sess";
    process.env.PI_ORCH_TASK_DIR = dir;
    const handlers: Record<string, Function> = {};
    workerExtension({
      on: (name: string, fn: Function) => {
        handlers[name] = fn;
      },
      registerTool: () => {},
      registerEntryRenderer: () => {},
      appendEntry: () => {},
    } as never);
    handlers.session_start({ reason: "startup" }, { sessionManager: { getSessionFile: () => "/sessions/abc.jsonl" } });
    assert.equal(readFileSync(join(dir, "session.txt"), "utf8"), "/sessions/abc.jsonl");
  } finally {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workerSessionFile: devolve o caminho só se o arquivo da sessão existir", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-sess-read-"));
  try {
    assert.equal(workerSessionFile(dir), null, "sem ponteiro");
    writeFileSync(join(dir, "session.txt"), join(dir, "nope.jsonl"));
    assert.equal(workerSessionFile(dir), null, "arquivo da sessão sumido");
    const real = join(dir, "real.jsonl");
    writeFileSync(real, "{}\n");
    writeFileSync(join(dir, "session.txt"), real);
    assert.equal(workerSessionFile(dir), real);
    assert.ok(existsSync(real));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
