import { test } from "node:test";
import assert from "node:assert/strict";
import { orphanReleaseNoticeFor } from "../src/orchestrator/extension.ts";

test("worktrees de tarefas terminais devolvidas viram aviso informativo, sem pedir ação", () => {
  const msg = orphanReleaseNoticeFor({
    released: [{ path: "/wt/a/1", holder: "t-a1", project: "alpha" }],
    kept: [],
  });
  assert.match(msg, /devolvidas automaticamente \(1\): alpha: \/wt\/a\/1 \(t-a1\)/);
  assert.doesNotMatch(msg, /se o usuário pedir|orch_release/);
});

test("worktree mantida traz o motivo e continua sem nova ação automática", () => {
  const msg = orphanReleaseNoticeFor({
    released: [],
    kept: [{ path: "/wt/b/2", holder: "t-b2", project: "beta", note: "tem alterações não commitadas" }],
  });
  assert.match(msg, /mantidas \(1\): beta: \/wt\/b\/2 \(t-b2\): tem alterações não commitadas/);
});
