import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nextPublishState,
  publishActionsIn,
  publishBlockReason,
  readPublishState,
  reconcilePublish,
  writePublishState,
  type PublishState,
} from "../src/shared/publish.ts";

const base = (over: Partial<PublishState> = {}): PublishState => ({
  task_id: "t-1",
  attempt_id: "a-1",
  branch: "feat/x",
  base_sha: "b0",
  head_sha: "h1",
  pushed_sha: null,
  pr_url: null,
  ...over,
});
const here = { branch: "feat/x", head_sha: "h1" };
const at = (g: { branch: string | null; head_sha: string | null }) => () => g;
const ALL = ["create_branch", "commit", "push", "open_pr"];

test("classifica commit, push e abertura de PR, inclusive em comandos encadeados", () => {
  assert.deepEqual(publishActionsIn("git commit -m x"), ["commit"]);
  assert.deepEqual(publishActionsIn("cd repo && git push -u origin feat/x"), ["push"]);
  assert.deepEqual(publishActionsIn("git -C /x push origin b"), ["push"]);
  assert.deepEqual(publishActionsIn("gh pr create --title t"), ["open_pr"]);
  assert.deepEqual(publishActionsIn("gh-axi pr create"), ["open_pr"]);
  assert.deepEqual(publishActionsIn("git status && npm test"), []);
  assert.deepEqual(publishActionsIn("git pushd-foo"), []);
});

test("ação fora de allowed_actions é bloqueada com o motivo (report não publica)", () => {
  const reason = publishBlockReason("git push origin feat/x", [], null, at(here));
  assert.match(reason ?? "", /push.*allowed_actions/);
  assert.equal(publishBlockReason("git commit -m x", ["commit"], null, at(here)), null);
});

test("comando sem ação de publicação nunca é bloqueado, mesmo sem permissão", () => {
  assert.equal(publishBlockReason("npm test", [], null, at(here)), null);
});

test("PR já registrada não é criada de novo", () => {
  const reason = publishBlockReason("gh pr create", ALL, base({ pr_url: "https://github.com/o/r/pull/9" }), at(here));
  assert.match(reason ?? "", /pull\/9/);
});

test("push em branch diferente da do attempt é bloqueado", () => {
  const reason = publishBlockReason("git push origin master", ALL, base(), at({ branch: "master", head_sha: "h1" }));
  assert.match(reason ?? "", /branch/);
});

test("HEAD já publicado não é empurrado de novo; commit novo libera o push", () => {
  const pushed = base({ pushed_sha: "h1" });
  assert.match(publishBlockReason("git push", ALL, pushed, at(here)) ?? "", /já publicado/);
  assert.equal(publishBlockReason("git push", ALL, pushed, at({ branch: "feat/x", head_sha: "h2" })), null);
});

test("primeira publicação, sem estado anterior, segue normalmente", () => {
  assert.equal(publishBlockReason("git push -u origin feat/x", ALL, null, at(here)), null);
});

test("nextPublishState grava fatos do git e preserva a URL da PR de tentativas anteriores da mesma tarefa", () => {
  const ids = { task_id: "t-1", attempt_id: "a-1", base_sha: "b0" };
  const first = nextPublishState(null, ids, { branch: "feat/x", head_sha: "h1", pushed_sha: null }, null);
  assert.deepEqual(first, base());
  const later = nextPublishState(
    first,
    ids,
    { branch: "feat/x", head_sha: "h1", pushed_sha: "h1" },
    "https://github.com/o/r/pull/9",
  );
  assert.equal(later.pushed_sha, "h1");
  assert.equal(later.pr_url, "https://github.com/o/r/pull/9");
  const otherTask = nextPublishState(
    first,
    { ...ids, task_id: "t-2" },
    { branch: "x", head_sha: "h9", pushed_sha: null },
  );
  assert.equal(otherTask.branch, "x");
  assert.equal(otherTask.pr_url, null);
});

test("reconcilePublish recupera a URL de PR já criada antes de um reinício, sem duplicar", () => {
  const calls: string[] = [];
  const found = reconcilePublish(base({ pushed_sha: "h1" }), (b) => {
    calls.push(b);
    return "https://github.com/o/r/pull/9";
  });
  assert.equal(found.pr_url, "https://github.com/o/r/pull/9");
  assert.deepEqual(calls, ["feat/x"]);
  const unpushed = reconcilePublish(base(), () => {
    throw new Error("não deveria consultar a PR sem push");
  });
  assert.equal(unpushed.pr_url, null);
});

test("publish-state.json sobrevive a reinício (round trip atômico)", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  try {
    assert.equal(readPublishState(dir), null);
    writePublishState(dir, base({ pushed_sha: "h1", pr_url: "https://github.com/o/r/pull/9" }));
    assert.deepEqual(readPublishState(dir), base({ pushed_sha: "h1", pr_url: "https://github.com/o/r/pull/9" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
