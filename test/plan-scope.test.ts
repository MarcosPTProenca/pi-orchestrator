import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore, itemOwnedBy, planOwnedBy } from "../src/orchestrator/plans.ts";
import { ownsByRepo, scopeKey } from "../src/shared/lock.ts";
import { makeHarness } from "./fakes.ts";

function twoRepos(): { repoA: string; repoB: string } {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "orch-plan-scope-")));
  const repoA = join(parent, "pi-orchestrator");
  const repoB = join(parent, "adaptative-learning");
  for (const r of [repoA, repoB]) {
    mkdirSync(r);
    execFileSync("git", ["init", "-q", r]);
  }
  return { repoA, repoB };
}

test("plano de um projeto não é controlado pela sessão de outro projeto", () => {
  const { repoA, repoB } = twoRepos();
  const ownsA = (p: string) => ownsByRepo(p, scopeKey(repoA), repoA);
  const ownsB = (p: string) => ownsByRepo(p, scopeKey(repoB), repoB);
  const store = new PlanStore(mkdtempSync(join(tmpdir(), "plans-scope-")), () => "2026-11-25T00:00:00.000Z");
  const plan = store.create("pi-factory-repro-168", "Repro 168", [
    { title: "PR #193", delegate: { project_path: repoA, request: "x", objective: "y", mode: "direct-pr" } },
  ]);

  assert.equal(planOwnedBy(plan, ownsA), true, "sessão do projeto do plano controla o plano");
  assert.equal(planOwnedBy(plan, ownsB), false, "sessão de outro projeto NÃO controla o plano");
  assert.equal(itemOwnedBy(plan.items[0], ownsB), false, "sessão de outro projeto não recebe item do plano");
  assert.equal(itemOwnedBy(plan.items[0], ownsA), true, "sessão do projeto recebe o item");
});

test("plano sem delegate não tem dono em nenhuma sessão com escopo", () => {
  const { repoA } = twoRepos();
  const ownsA = (p: string) => ownsByRepo(p, scopeKey(repoA), repoA);
  const store = new PlanStore(mkdtempSync(join(tmpdir(), "plans-scope-")), () => "2026-11-25T00:00:00.000Z");
  const plan = store.create("manual", "Manual", ["passo sem delegate"]);
  assert.equal(planOwnedBy(plan, ownsA), false);
});

test("sessão com escopo não controla tarefa de outro escopo (owner_key)", async () => {
  const { repoA, repoB } = twoRepos();
  const h = makeHarness();
  h.orch.setScope(scopeKey(repoA), (p) => ownsByRepo(p, scopeKey(repoA), repoA));
  const t = await h.orch.delegate({ project_path: repoA, role: "a", request: "x", objective: "y", mode: "report" });

  assert.equal(h.orch.ownsTask(h.orch.get(t.task_id)), true, "dona da tarefa controla");
  h.orch.setScope(scopeKey(repoB), (p) => ownsByRepo(p, scopeKey(repoB), repoB));
  assert.equal(h.orch.ownsTask(h.orch.get(t.task_id)), false, "outra sessão não controla a tarefa");
});
