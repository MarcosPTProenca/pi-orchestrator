import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
const head = (cwd: string) => git(cwd, "rev-parse", "HEAD").stdout.trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pi-orch-sync-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const inst = join(root, "inst");
  git(root, "init", "-q", "--bare", "-b", "master", origin);
  git(root, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "master");
  mkdirSync(join(seed, "bin"));
  mkdirSync(join(seed, "src"));
  cpSync(join(repoRoot, "bin", "pi-orch"), join(seed, "bin", "pi-orch"));
  cpSync(join(repoRoot, "bin", "pi-factory"), join(seed, "bin", "pi-factory"));
  writeFileSync(join(seed, "src", "index.ts"), "x\n");
  writeFileSync(join(seed, "f.txt"), "a\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "master");
  git(root, "clone", "-q", origin, inst);
  const stub = join(root, "stub");
  mkdirSync(stub);
  writeFileSync(join(stub, "pi"), '#!/usr/bin/env bash\necho "stub pi"\n');
  chmodSync(join(stub, "pi"), 0o755);
  return { root, origin, seed, inst, stub };
}

function run(cwd: string, stub: string, env: Record<string, string> = {}) {
  const { HERDR_ENV, HERDR_PANE_ID, ...rest } = process.env;
  return spawnSync("bash", [join(cwd, "bin", "pi-orch")], {
    cwd,
    encoding: "utf8",
    env: { ...rest, PATH: `${stub}:${process.env.PATH}`, HERDR_ENV: "1", HERDR_PANE_ID: "p1", ...env },
  });
}

test("launcher avança para master quando está atrás do origin", () => {
  const t = setup();
  writeFileSync(join(t.seed, "f.txt"), "b\n");
  git(t.seed, "commit", "-qam", "up");
  git(t.seed, "push", "-q", "origin", "master");
  const r = run(t.inst, t.stub);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /atualizado com master/);
  assert.equal(head(t.inst), git(t.inst, "rev-parse", "origin/master").stdout.trim());
});

test("launcher respeita PI_ORCH_NO_SYNC=1", () => {
  const t = setup();
  writeFileSync(join(t.seed, "f.txt"), "b\n");
  git(t.seed, "commit", "-qam", "up");
  git(t.seed, "push", "-q", "origin", "master");
  const before = head(t.inst);
  const r = run(t.inst, t.stub, { PI_ORCH_NO_SYNC: "1" });
  assert.equal(r.status, 0);
  assert.equal(head(t.inst), before);
});

test("launcher não bloqueia quando o origin some", () => {
  const t = setup();
  git(t.inst, "remote", "set-url", "origin", join(t.root, "nao-existe.git"));
  const r = run(t.inst, t.stub);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /sync com master não aplicado/);
  assert.match(r.stdout, /stub pi/);
});

test("launcher pula o sync com mudanças locais em arquivo rastreado", () => {
  const t = setup();
  writeFileSync(join(t.inst, "f.txt"), "local\n");
  const before = head(t.inst);
  const r = run(t.inst, t.stub);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /sync com master pulado/);
  assert.equal(head(t.inst), before);
  assert.equal(readFileSync(join(t.inst, "f.txt"), "utf8"), "local\n");
});
