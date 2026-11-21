import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownsByRepo, scopeKey } from "../src/lock.ts";
import { makeHarness, type Harness } from "./fakes.ts";
import { Store } from "../src/store.ts";

function layout(): { parent: string; repoA: string; repoB: string } {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "orch-cc-")));
  const repoA = join(parent, "repoA");
  const repoB = join(parent, "repoB");
  for (const r of [repoA, repoB]) {
    mkdirSync(r);
    execFileSync("git", ["init", "-q", r]);
  }
  return { parent, repoA, repoB };
}

test("controle compartilhado: sessão do repo controla as tarefas do próprio repo, dono pasta-pai incluído", () => {
  const { parent, repoA } = layout();
  assert.equal(ownsByRepo(repoA, scopeKey(repoA), repoA), true, "tarefa do repo, sessão do repo");
  assert.equal(ownsByRepo(repoA, scopeKey(repoA), repoA), true);
});

test("controle compartilhado: pasta-pai controla as tarefas de repos dentro dela", () => {
  const { parent, repoA } = layout();
  assert.equal(ownsByRepo(repoA, scopeKey(parent), parent), true);
});

test("sem controle cruzado: sessão de um repo não controla tarefas de outro repo", () => {
  const { repoA, repoB } = layout();
  assert.equal(ownsByRepo(repoB, scopeKey(repoA), repoA), false);
});

test("sem controle cruzado: pasta-pai não controla tarefas fora da pasta", () => {
  const { parent } = layout();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "orch-out-")));
  assert.equal(ownsByRepo(outside, scopeKey(parent), parent), false);
});

test("tarefa de repo com dono pasta-pai passa a ser controlada pela sessão do repo (preserva a tarefa)", () => {
  const { parent, repoA } = layout();
  const h: Harness = makeHarness();
  const store = new Store(join(h.stateDir, "state.json"));
  store.mutate((s) => {
    s.tasks["t-adotada"] = {
      task_id: "t-adotada",
      project_path: repoA,
      owner_key: scopeKey(parent),
      status: "done",
      tab_id: "",
      pane_id: "",
      terminal_id: "",
      notified: true,
    } as never;
  });
  h.orch.setScope(scopeKey(repoA), (p) => ownsByRepo(p, scopeKey(repoA), repoA));
  assert.deepEqual(
    h.orch.owned().map((t) => t.task_id),
    ["t-adotada"],
  );
});

test("trava por tarefa: dois cancelamentos simultâneos fecham a tab uma vez só", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  h.herdr.calls = [];
  const results = await Promise.allSettled([h.orch.cancel(t.task_id), h.orch.cancel(t.task_id)]);
  assert.ok(
    results.every((r) => r.status === "fulfilled"),
    "os dois terminam sem erro",
  );
  assert.equal(h.herdr.calls.filter((c) => c.op === "closeTab").length, 1, "uma única tab fechada");
  assert.equal(h.orch.get(t.task_id).status, "cancelled");
});

test("trava de processo morto expira e a operação segue", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  const lock = join(h.stateDir, "tasks", `${t.task_id}.oplock`);
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  await h.orch.cancel(t.task_id);
  assert.equal(h.orch.get(t.task_id).status, "cancelled");
});
