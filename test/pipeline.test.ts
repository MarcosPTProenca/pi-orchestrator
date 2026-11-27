import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideIntegration, IntegrationStore, requestIntegration } from "../src/shared/merge-gate.ts";
import { tddCheck, type EvidenceLog } from "../src/shared/execution-evidence.ts";
import {
  aggregate,
  authorizedPolicy,
  integrationParams,
  openStores,
  runDelivery,
  TASK,
  ticketFacts,
  WORKER,
  type RunResult,
  type Scenario,
} from "../evals/pipeline/engine.ts";
import { FakeGithub, BRANCH, PR_NUMBER, REPO, REVIEWER, sha } from "../evals/pipeline/fakes.ts";
import * as S from "../evals/pipeline/scenarios.ts";

const dir = (): string => mkdtempSync(join(tmpdir(), "pipe-148-"));
const run = (sc: Scenario): Promise<RunResult> => runDelivery(sc, dir());
const mergeHead = (args: string[]): string => args[args.indexOf("--match-head-commit") + 1];

test("bug localizado: teste vermelho antes e verde depois; PR aberta e revisada", async () => {
  const log: EvidenceLog = {
    commands: [
      { command: "npm test -- bug", exit_code: 1, at: "t0", excerpt: "not ok 1" },
      { command: "npm test -- bug", exit_code: 0, at: "t1", excerpt: "ok 1" },
    ],
    marks: [
      { seam: "fix-loop", phase: "red", command_index: 0 },
      { seam: "fix-loop", phase: "green", command_index: 1 },
    ],
  };
  const tdd = tddCheck(log, ["fix-loop"]);
  assert.deepEqual(tdd.problems, []);
  assert.equal(tdd.seams[0].red.exit_code, 1);
  const badRed = tddCheck({ ...log, commands: [{ ...log.commands[0], exit_code: 0 }, log.commands[1]] }, ["fix-loop"]);
  assert.ok(badRed.problems.some((p) => p.includes("red não falhou")));

  const r = await run(S.BUG_TDD);
  assert.deepEqual(r.transitions.slice(0, 2), ["pr_open@0001", "review_pending@0001"]);
  assert.deepEqual(r.reviews, [{ head: sha(1), verdict: "approve" }]);
  assert.equal(r.github.pr.head_ref, BRANCH);
});

test("reviewer encontra defeito real: worker corrige na mesma branch, novo SHA e nova revisão", async () => {
  const r = await run(S.REVIEW_DEFECT_FIXED);
  assert.deepEqual(r.heads, [sha(1), sha(2)]);
  assert.deepEqual(r.reviews, [
    { head: sha(1), verdict: "request_changes" },
    { head: sha(2), verdict: "approve" },
  ]);
  assert.deepEqual(r.prompt_targets, [WORKER]);
  assert.equal(r.rework, 1);
  assert.equal(r.github.pr.head_ref, BRANCH);
  assert.equal(r.terminal, "merged");
  assert.equal(mergeHead(r.github.mergeCalls[0]), sha(2));
});

test("reprovação repetida esgota o limite de ciclos e não mergeia", async () => {
  const r = await run(S.REVIEW_EXHAUSTED);
  assert.equal(r.terminal, "blocked");
  assert.match(r.reason ?? "", /limite de 2 ciclos/);
  assert.equal(r.rework, 2);
  assert.equal(r.github.mergeCalls.length, 0);
});

test("CI vermelho por bug: worker corrige e a PR é mergeada só no head corrigido", async () => {
  const r = await run(S.CI_BUG_FIXED);
  assert.deepEqual(
    r.ci.map((c) => c.conclusion),
    ["FAILURE", "SUCCESS"],
  );
  assert.ok(r.transitions.includes("changes_required@0001"));
  assert.equal(r.terminal, "merged");
  assert.equal(mergeHead(r.github.mergeCalls[0]), sha(2));
});

test("CI infra/flaky é sinalizado sem acionar worker nem consumir tentativas", async () => {
  const r = await run(S.CI_INFRA_BOUNDED);
  assert.equal(r.rework, 0);
  assert.equal(r.fix_attempts, 0);
  assert.equal(r.ci.length, 1);
  assert.equal(r.terminal, "stalled");
  assert.match(r.reason ?? "", /infra/);
  assert.equal(
    r.transitions.some((t) => t.startsWith("changes_required")),
    false,
  );
  assert.equal(r.github.mergeCalls.length, 0);
});

test("auto-merge L0 autorizado mergeia após confirmação do GitHub", async () => {
  const r = await run(S.L0_AUTO_MERGE);
  assert.equal(r.terminal, "merged");
  assert.equal(r.advanced_at_tick, 1);
  assert.equal(r.github.mergeCalls.length, 1);
});

test("auto-merge L1 autorizado mergeia somente o head que tem review aprovado", async () => {
  const r = await run(S.BUG_TDD);
  assert.equal(r.terminal, "merged");
  const approved = r.reviews.filter((x) => x.verdict === "approve").map((x) => x.head);
  assert.deepEqual(approved, [mergeHead(r.github.mergeCalls[0])]);
});

const STOPS: [Scenario, string][] = [
  [S.L2_MANUAL, "risk_requires_human"],
  [S.L3_MANUAL, "risk_requires_human"],
  [S.NO_POLICY, "policy_unavailable"],
  [S.NO_AUTHORIZATION, "no_merge_authorization"],
];

for (const [sc, code] of STOPS) {
  test(`bloqueio sem merge pelo motivo certo: ${sc.title}`, async () => {
    const r = await run(sc);
    assert.ok(r.terminal === "manual_approval" || r.terminal === "blocked", `terminal inesperado: ${r.terminal}`);
    assert.ok(r.integrations[0].codes.includes(code), `códigos: ${r.integrations[0].codes.join(",")}`);
    assert.equal(r.github.mergeCalls.length, 0);
    assert.equal(r.github.pr.state, "OPEN");
  });
}

test("aprovação duplicada não gera segundo merge; o integrador deduplica", async () => {
  const r = await run(S.DUPLICATE_APPROVAL);
  assert.equal(r.github.mergeCalls.length, 1);
  assert.deepEqual(
    r.integrations.map((i) => i.decision),
    ["merge_requested", "already_requested"],
  );
  assert.deepEqual(r.redeliveries, ["approved"]);
  assert.equal(r.terminal, "merged");
});

test("reinício: loja de integração reaberta não repete o merge já pedido", async () => {
  const r = await run(S.L0_AUTO_MERGE);
  const again = openStores(r.stateDir, 2);
  const res = await requestIntegration(integrationParams(sha(1)), { github: r.github, store: again.integ });
  assert.equal(res.decision, "already_merged");
  assert.equal(r.github.mergeCalls.length, 1);
});

test("reinício: loja do fix loop reaberta não reenvia achados já enviados", async () => {
  const r = await run(S.REVIEW_DEFECT_FIXED);
  const again = openStores(r.stateDir, 2);
  const out = again.fix.apply(TASK, { type: "review", head_sha: sha(1), verdict: "request_changes", blocking: 1 });
  assert.equal(out.action.kind, "none");
  assert.equal(r.prompt_targets.length, 1);
});

test("crash entre o pedido e o registro: nova tentativa vira integration_interrupted, sem segundo merge", async () => {
  const stateDir = dir();
  const { integ } = openStores(stateDir, 2);
  const key = `${REPO}#${PR_NUMBER}@${sha(1)}`;
  assert.equal(new IntegrationStore(integ.dir).claim(key).claimed, true);
  const gh = new FakeGithub(sha(1), S.L0_AUTO_MERGE.files);
  gh.setCheck({
    name: "test",
    app_slug: "github-actions",
    head_sha: sha(1),
    status: "COMPLETED",
    conclusion: "SUCCESS",
  });
  gh.setCheck({
    name: REVIEWER.check_name,
    app_slug: REVIEWER.app_slug,
    head_sha: sha(1),
    status: "COMPLETED",
    conclusion: "SUCCESS",
  });
  const res = await requestIntegration(integrationParams(sha(1)), {
    github: gh,
    store: new IntegrationStore(integ.dir),
  });
  assert.equal(res.decision, "blocked");
  assert.ok(res.reasons.some((x) => x.code === "integration_interrupted"));
  assert.equal(gh.mergeCalls.length, 0);
});

test("A→B: o item B só é liberado depois do merge confirmado, sem turno de LLM para avançar", async () => {
  const r = await run(S.PLAN_A_TO_B);
  assert.equal(r.terminal, "merged");
  assert.equal(r.advanced_at_tick, 2);
  assert.deepEqual(r.ready_per_tick, [[], ["2"]]);
});

test("A→B: merge pedido e não confirmado não libera o item B", async () => {
  const r = await run(S.PLAN_MERGE_PENDING);
  assert.equal(r.terminal, "merge_unconfirmed");
  assert.equal(r.advanced_at_tick, null);
  assert.ok(r.ready_per_tick.every((ready) => ready.length === 0));
  assert.equal(r.github.mergeCalls.length, 1);
});

test("mudança de escopo bloqueia o merge", async () => {
  const r = await run(S.SCOPE_DRIFT);
  assert.equal(r.terminal, "blocked");
  assert.ok(r.integrations[0].codes.includes("scope_drift"));
  assert.equal(r.github.mergeCalls.length, 0);
});

test("aprovação obsoleta não vale: review do head anterior não autoriza o head atual", async () => {
  const gh = new FakeGithub(sha(2), S.REVIEW_DEFECT_FIXED.files);
  gh.setCheck({
    name: "test",
    app_slug: "github-actions",
    head_sha: sha(2),
    status: "COMPLETED",
    conclusion: "SUCCESS",
  });
  gh.setCheck({
    name: REVIEWER.check_name,
    app_slug: REVIEWER.app_slug,
    head_sha: sha(1),
    status: "COMPLETED",
    conclusion: "SUCCESS",
  });
  const snap = await gh.snapshot();
  const input = {
    policy: authorizedPolicy(),
    ticket: ticketFacts(),
    pr: snap.pr,
    repo: snap.repo,
    protection: snap.protection,
    reviewer: REVIEWER,
    expected_head_sha: sha(2),
  };
  const stale = decideIntegration(input);
  assert.equal(stale.decision, "manual_approval");
  assert.ok(stale.reasons.some((x) => x.code === "review_unverified"));

  gh.setCheck({
    name: REVIEWER.check_name,
    app_slug: REVIEWER.app_slug,
    head_sha: sha(2),
    status: "COMPLETED",
    conclusion: "SUCCESS",
  });
  const parecer = {
    level: "L0" as const,
    category: "fixture",
    reason: "fixture",
    confidence: "high" as const,
    requires_human_judgment: false,
    scope_drift: false,
  };
  const fresh = decideIntegration({
    ...input,
    reviewer: null,
    review: { head_sha: sha(2), approved: true, assessment: parecer },
    pr: (await gh.snapshot()).pr,
  });
  assert.equal(fresh.decision, "merge_requested");
});

test("race: head muda entre a análise e o merge; o merge é recusado e nada é mergeado", async () => {
  const r = await run(S.MERGE_RACE);
  assert.equal(r.terminal, "blocked");
  assert.equal(r.github.mergeCalls.length, 1);
  assert.equal(r.github.pr.state, "OPEN");
  assert.ok(r.integrations[0].codes.includes("merge_request_failed"));
});

test("falha de merge não é reenviada no mesmo head", async () => {
  const r = await run(S.MERGE_FAILED_RETRY);
  assert.equal(r.github.mergeCalls.length, 1);
  assert.deepEqual(
    r.integrations.map((i) => i.codes[0]),
    ["merge_request_failed", "integration_failed_for_head"],
  );
  assert.equal(r.terminal, "blocked");
});

test("revisão sem veredito conclusivo fica parada e não vira done", async () => {
  const r = await run(S.REVIEW_UNVERIFIED);
  assert.equal(r.terminal, "stalled");
  assert.equal(r.github.mergeCalls.length, 0);
});

test("agregado: nenhuma PR mergeada indevidamente e cenários esperados batem com o desfecho", async () => {
  const results: RunResult[] = [];
  for (const sc of S.ALL_SCENARIOS) results.push(await run(sc));
  const m = aggregate(results);
  assert.equal(m.improper_merges, 0);
  assert.equal(m.missed_merges, 0);
  assert.equal(m.scenarios, S.ALL_SCENARIOS.length);
  assert.ok(m.tokens_simulated > 0);
});
