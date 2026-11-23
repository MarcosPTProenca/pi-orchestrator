import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnership,
  legacyAdopter,
  ownsByRepo,
  releaseOwnership,
  scopeKey,
  scopeOwnerDir,
} from "../src/shared/lock.ts";

function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "orch-wt-")));
  const main = join(base, "main");
  const other = join(base, "other");
  const wt = join(base, "wt");
  const state = join(base, "state");
  mkdirSync(state);
  for (const r of [main, other]) {
    mkdirSync(r);
    execFileSync("git", ["-C", r, "init", "-q"]);
    execFileSync("git", [
      "-C",
      r,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
  }
  execFileSync("git", ["-C", main, "worktree", "add", "-q", wt, "-b", "lease-test"]);
  return { main, other, wt, state };
}

test("sessão numa worktree controla as tarefas do repo principal, não as de outro repo (#59)", () => {
  const { main, other, wt } = layout();
  assert.equal(ownsByRepo(main, scopeKey(wt), wt), true, "mesmo repositório (worktree)");
  assert.equal(ownsByRepo(other, scopeKey(wt), wt), false, "outro repositório fica de fora");
});

test("sessão numa worktree adota a legada do principal só quando o principal não tem dono vivo (#59)", () => {
  const { main, wt, state } = layout();
  const adopt = legacyAdopter({ key: scopeKey(wt), cwd: wt, stateDir: state });
  assert.equal(adopt(main), true, "principal sem sessão viva: adota");
  const owner = scopeOwnerDir(state, scopeKey(main));
  assert.equal(acquireOwnership(owner).owner, true);
  try {
    assert.equal(adopt(main), false, "principal com sessão viva: fica com ela");
  } finally {
    releaseOwnership(owner);
  }
});
