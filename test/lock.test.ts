import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acquireOwnership, releaseOwnership } from "../src/lock.ts";

const ROOT = process.cwd();
function childAcquire(dir: string): { owner: boolean; holder?: { pid: number } } {
  const code = `import("./src/lock.ts").then(m=>{const r=m.acquireOwnership(${JSON.stringify(dir)});console.log(JSON.stringify(r));process.exit(0)})`;
  const out = spawnSync(process.execPath, ["--import", "tsx", "-e", code], { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) throw new Error(out.stderr);
  return JSON.parse(out.stdout.trim().split("\n").pop() as string);
}

test("primeira instância vira dona; segunda instância viva não é dona", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-lock-"));
  assert.equal(acquireOwnership(dir).owner, true);
  const second = childAcquire(dir);
  assert.equal(second.owner, false, "processo filho não pode ser dono enquanto o pai vive");
  assert.equal(second.holder?.pid, process.pid);
  releaseOwnership(dir);
  assert.equal(existsSync(join(dir, "owner.json")), false);
});

test("posse de processo morto é retomada", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-lock-"));
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(dead.status, 0);
  const pidMorto = 2 ** 22 - 3;
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: pidMorto, started_at: "x" }));
  assert.equal(acquireOwnership(dir).owner, true);
  assert.equal(JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")).pid, process.pid);
  releaseOwnership(dir);
});

test("arquivo de posse corrompido não trava a instância", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-lock-"));
  writeFileSync(join(dir, "owner.json"), "{não é json");
  assert.equal(acquireOwnership(dir).owner, true);
  releaseOwnership(dir);
});

test("soltar a posse não remove o arquivo de outro processo", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-lock-"));
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.ppid, started_at: "x" }));
  releaseOwnership(dir);
  assert.equal(existsSync(join(dir, "owner.json")), true);
});
