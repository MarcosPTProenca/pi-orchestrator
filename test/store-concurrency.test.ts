import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/shared/store.ts";

const STORE = fileURLToPath(new URL("../src/shared/store.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function writer(file: string, n: number): Promise<void> {
  const code = `
const { Store } = await import(${JSON.stringify(STORE)});
const s = new Store(${JSON.stringify(file)});
for (let i = 0; i < ${n}; i++) s.mutate((st) => { st.tasks[process.pid + "-" + i] = { task_id: process.pid + "-" + i }; });`;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { cwd: ROOT, timeout: 120_000 },
      (err, _out, stderr) => (err ? reject(new Error(`${err.message} ${stderr}`)) : resolve()),
    );
  });
}

test("três sessões gravando o mesmo state.json ao mesmo tempo não perdem registros (#55)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-conc-"));
  const file = join(dir, "state.json");
  try {
    await Promise.all([writer(file, 30), writer(file, 30), writer(file, 30)]);
    const tasks = new Store(file).load().tasks;
    assert.equal(Object.keys(tasks).length, 90, "cada gravação sobrevive; nenhuma sobrescreve a outra");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
