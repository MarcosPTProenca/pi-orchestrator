import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePublishState, type PublishState } from "../src/shared/publish.ts";
import { inspectLease, releaseLease, treehouseOps, type WorktreeOps } from "../src/shared/worktrees.ts";
import { makeHarness, reopenHarness, type Harness } from "./fakes.ts";

// keep: git real em repositório temporário; só o treehouse é falso (lista leases por task_id).
function git(cwd: string, ...args: string[]): string {
  // keep: hooks globais do usuário (commit-msg) não devem rodar nos repositórios temporários.
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

function newRepo(root: string, name: string): { clone: string; base: string } {
  const origin = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  const clone = join(root, name);
  git(root, "init", "--bare", "-q", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "commit", "-q", "--allow-empty", "-m", "base");
  git(seed, "push", "-q", origin, "main");
  git(root, "clone", "-q", origin, clone);
  return { clone, base: git(clone, "rev-parse", "HEAD") };
}

function commitWork(clone: string): string {
  git(clone, "commit", "-q", "--allow-empty", "-m", "trabalho");
  return git(clone, "rev-parse", "HEAD");
}

interface Work {
  t: { task_id: string; task_dir: string; pane_id: string };
  clone: string;
  base: string;
}

interface Setup {
  root: string;
  h: Harness;
  leases: Map<string, string>;
  returned: string[];
}

function setup(inspectOverride?: () => never): Setup {
  const root = mkdtempSync(join(tmpdir(), "lost-diag-"));
  const leases = new Map<string, string>();
  const returned: string[] = [];
  const ops: WorktreeOps = {
    status: () => [...leases].map(([holder, path]) => `/proj leased ${path} (held by ${holder})`).join("\n"),
    git: (path, args) => treehouseOps.git(path, args),
    returnTree: (p) => {
      returned.push(p);
    },
  };
  const h = makeHarness({
    extra: {
      releaseWorktree: (t) => releaseLease(ops, t.project_path, t.task_id).message,
      inspectWorktree: inspectOverride ?? ((t) => inspectLease(ops, t.project_path, t.task_id)),
    },
  });
  return { root, h, leases, returned };
}

async function delegateWithWorktree(s: Setup, role: string): Promise<Work> {
  const t = await s.h.orch.delegate({
    project_path: s.h.project,
    role,
    request: "x",
    objective: "y",
    mode: "report",
  });
  const repo = newRepo(s.root, t.task_id);
  s.leases.set(t.task_id, repo.clone);
  return { t, ...repo };
}

function recordPublish(w: Work, over: Partial<PublishState>): void {
  writePublishState(w.t.task_dir, {
    task_id: w.t.task_id,
    attempt_id: "att-1",
    branch: "main",
    base_sha: w.base,
    head_sha: null,
    pushed_sha: null,
    pr_url: null,
    ...over,
  });
}

function paneGone(h: Harness, paneId: string): void {
  h.herdr.panesList = h.herdr.panesList.filter((p) => p.pane_id !== paneId);
}

test("1. pane sumido sem trabalho: nível none, com a worktree conferida e sem ler o painel", async () => {
  const s = setup();
  const w = await delegateWithWorktree(s, "a");
  paneGone(s.h, w.t.pane_id);
  await s.h.orch.reconcile();

  const rec = s.h.orch.get(w.t.task_id);
  assert.equal(rec.status, "lost");
  assert.equal(rec.diagnosis?.level, "none");
  const wt = rec.diagnosis?.sources.find((x) => x.source === "worktree");
  assert.equal(wt?.state, "verificada");
  assert.ok(wt?.detail.includes(w.clone));
  assert.match(rec.error ?? "", /Diagnóstico \(none\)/);
  assert.equal(s.h.herdr.opsOf("readRecent").length, 0);
});

test("2. commit local sem push: nível partial, cita o commit e preserva a worktree", async () => {
  const s = setup();
  const w = await delegateWithWorktree(s, "a");
  const head = commitWork(w.clone);
  recordPublish(w, { head_sha: head });
  paneGone(s.h, w.t.pane_id);
  await s.h.orch.reconcile();

  const rec = s.h.orch.get(w.t.task_id);
  assert.equal(rec.status, "lost");
  assert.equal(rec.diagnosis?.level, "partial");
  assert.ok(rec.diagnosis?.evidence.includes(`commit ${head.slice(0, 12)} criado na worktree, não publicado`));
  assert.ok(rec.error?.includes(`inspecione a worktree ${w.clone}`));
  assert.deepEqual(s.returned, [], "worktree com commit sem push não é devolvida");
  assert.ok(existsSync(w.clone));
});

test("3. PR registrada: nível partial, checks pendentes, tarefa segue lost e não vira done", async () => {
  const s = setup();
  const w = await delegateWithWorktree(s, "a");
  const head = commitWork(w.clone);
  git(w.clone, "push", "-q", "origin", "HEAD:refs/heads/feat/x");
  const prUrl = "https://github.com/o/r/pull/12";
  recordPublish(w, { branch: "feat/x", head_sha: head, pushed_sha: head, pr_url: prUrl });
  paneGone(s.h, w.t.pane_id);
  await s.h.orch.reconcile();

  const rec = s.h.orch.get(w.t.task_id);
  assert.equal(rec.status, "lost");
  assert.equal(rec.diagnosis?.level, "partial");
  assert.ok(rec.diagnosis?.evidence.includes(`PR ${prUrl}`));
  assert.ok(rec.diagnosis?.pending.includes("checks da PR não consultados neste diagnóstico"));
});

test("4. pane reutilizado por outro agente: não lê nem envia ao painel e não toca worktree de terceiros", async () => {
  const s = setup();
  const a = await delegateWithWorktree(s, "a");
  const b = await delegateWithWorktree(s, "b");
  recordPublish(a, { head_sha: commitWork(a.clone) });
  s.h.herdr.panesList = s.h.herdr.panesList.map((p) =>
    p.pane_id === a.t.pane_id ? { ...p, terminal_id: "term_outro_agente", agent: "pi", agent_status: "working" } : p,
  );
  const promptsBefore = s.h.herdr.opsOf("prompt").length;
  const bStatusBefore = s.h.orch.get(b.t.task_id).status;
  await s.h.orch.reconcile();

  const rec = s.h.orch.get(a.t.task_id);
  assert.equal(rec.status, "lost");
  assert.match(rec.error ?? "", /trocou de agente/);
  const logs = rec.diagnosis?.sources.find((x) => x.source === "logs");
  assert.ok(logs?.detail.includes("painel trocou de agente: nada lido"));
  assert.equal(s.h.herdr.opsOf("readRecent").length, 0);
  assert.equal(s.h.herdr.opsOf("prompt").length, promptsBefore);
  assert.ok(!s.returned.includes(b.clone), "worktree de outra tarefa não é devolvida");
  assert.equal(s.h.orch.get(b.t.task_id).status, bStatusBefore, "a outra tarefa mantém seu estado");
  assert.ok(existsSync(b.clone));
});

test("5. reinício e reconciliação dupla: diagnóstico não é regravado nem reentregue", async () => {
  const s = setup();
  const w = await delegateWithWorktree(s, "a");
  recordPublish(w, { head_sha: commitWork(w.clone) });
  paneGone(s.h, w.t.pane_id);

  await s.h.orch.reconcile();
  const first = s.h.orch.get(w.t.task_id);
  await s.h.orch.reconcile();
  const second = s.h.orch.get(w.t.task_id);
  assert.deepEqual(second.diagnosis, first.diagnosis);
  assert.equal(second.updated_at, first.updated_at, "segunda reconciliação não grava de novo");

  const restarted = reopenHarness(s.h);
  await restarted.reconcile();
  const third = restarted.get(w.t.task_id);
  assert.deepEqual(third.diagnosis, first.diagnosis);
  assert.equal(third.status, "lost");

  const delivered = (await s.h.orch.inbox()).filter((e) => e.task_id === w.t.task_id);
  assert.equal(delivered.length, 1, "o aviso de perda sai uma vez");
  assert.match(delivered[0].error ?? "", /Diagnóstico \(partial\)/);
  const again = (await restarted.inbox()).filter((e) => e.task_id === w.t.task_id);
  assert.equal(again.length, 0, "reinício não reentrega o aviso");
});

test("6. fonte indisponível (worktree) é registrada com o motivo e não impede o estado lost", async () => {
  const s = setup(() => {
    throw new Error("treehouse status falhou");
  });
  const w = await delegateWithWorktree(s, "a");
  paneGone(s.h, w.t.pane_id);
  await s.h.orch.reconcile();

  const rec = s.h.orch.get(w.t.task_id);
  assert.equal(rec.status, "lost");
  const wt = rec.diagnosis?.sources.find((x) => x.source === "worktree");
  assert.equal(wt?.state, "indisponivel");
  assert.ok(wt?.detail.includes("treehouse status falhou"));
  assert.ok(rec.diagnosis?.pending.some((p) => p.includes("worktree não verificada")));
});

test("7. diagnóstico não relança: orch_relaunch recusa tarefa lost e o status segue lost", async () => {
  const s = setup();
  const w = await delegateWithWorktree(s, "a");
  paneGone(s.h, w.t.pane_id);
  await s.h.orch.reconcile();

  await assert.rejects(s.h.orch.relaunch(w.t.task_id), /só relança tarefa falha \(status: lost\)/);
  assert.equal(s.h.orch.get(w.t.task_id).status, "lost");
});
