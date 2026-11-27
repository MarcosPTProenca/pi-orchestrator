import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixLoopStore } from "../src/orchestrator/fix-loop.ts";
import { findingsText, reviewEvent } from "../src/orchestrator/review-verdict.ts";
import { prVerdict } from "../src/orchestrator/pr-watch.ts";
import type { PrState } from "../src/shared/prs.ts";
import { readReview, recordReviewVerdict, reviewFile, type PrRef } from "../src/shared/review-verdict.ts";
import { PlanStore, launchable } from "../src/orchestrator/plans.ts";
import { integrationRoute, repoPolicyFor, ticketFacts, ticketFor } from "../src/orchestrator/delivery.ts";
import type { TaskRecord } from "../src/shared/contract.ts";
import {
  decideIntegration,
  IntegrationStore,
  requestIntegration,
  type CheckRunFact,
  type MergeGithub,
  type PrSnapshot,
} from "../src/shared/merge-gate.ts";
import { MergePolicyStore, defaultMergePolicy, type ReviewAssessment } from "../src/shared/merge-policy.ts";

const ASSESS: ReviewAssessment = {
  level: "L0",
  category: "fixture",
  reason: "fixture de aprovação",
  confidence: "high",
  requires_human_judgment: false,
  scope_drift: false,
};

const REPO = "MarcosPTProenca/pi-orchestrator";
const PR_URL = `https://github.com/${REPO}/pull/200`;
const T_A = "t-aaaaaaaa";
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const dir = () => mkdtempSync(join(tmpdir(), "t118-"));
const PR: PrRef = { owner: "MarcosPTProenca", name: "pi-orchestrator", number: 200 };
const delegate = { project_path: "/tmp/repo", request: "faça", objective: "obj", mode: "direct-pr" };

const approveJson = (head: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: 2,
    verdict: "approve",
    reviewed_sha: head,
    risk_assessment: { level: "L1", category: "local", reason: "ajuste", evidence: ["src/x.ts:1"], confidence: "high" },
    requires_human_judgment: false,
    scope_drift: false,
    criteria: [{ id: "AC-1", status: "pass", evidence: "src/x.ts:1" }],
    findings: [],
    suggestions: [],
    ...over,
  });

const rejectJson = (head: string) =>
  JSON.stringify({
    schema_version: 2,
    verdict: "request_changes",
    reviewed_sha: head,
    risk_assessment: {
      level: "L0",
      category: "fixture",
      reason: "fixture",
      evidence: ["src/x.ts:9"],
      confidence: "high",
    },
    requires_human_judgment: false,
    scope_drift: false,
    criteria: [{ id: "AC-1", status: "fail", evidence: "src/x.ts:9" }],
    findings: [{ file: "src/x.ts", line: 9, cause: "falta teste", blocking: true }],
    suggestions: [],
  });

const fixStore = () =>
  new FixLoopStore(join(dir(), "fix.json"), { maxAttempts: 2, now: () => "2026-11-24T00:00:00.000Z" });

test("veredito de approve válido é gravado e vira evento de review sem bloqueante", () => {
  const d = dir();
  recordReviewVerdict(d, PR, approveJson(HEAD), HEAD, false);
  const r = readReview(d, PR, HEAD);
  assert.ok(r);
  assert.deepEqual(reviewEvent(r), { type: "review", head_sha: HEAD, verdict: "approve", blocking: 0 });
});

test("approve com diff truncado vira unverified e não aprova", () => {
  const d = dir();
  recordReviewVerdict(d, PR, approveJson(HEAD), HEAD, true);
  assert.equal(readReview(d, PR, HEAD)?.verdict, "unverified");
});

test("veredito de head antigo é ignorado; head inválido é recusado", () => {
  const d = dir();
  recordReviewVerdict(d, PR, approveJson(OLD), OLD, false);
  assert.equal(readReview(d, PR, HEAD), null, "review de outro head não vale");
  assert.equal(readReview(dir(), PR, HEAD), null, "sem arquivo, sem veredito");
  const antigo = dir();
  mkdirSync(join(reviewFile(antigo, PR, HEAD), ".."), { recursive: true });
  writeFileSync(reviewFile(antigo, PR, HEAD), JSON.stringify({ ...JSON.parse(approveJson(HEAD)), schema_version: 1 }));
  assert.equal(readReview(antigo, PR, HEAD), null, "review no schema antigo não autoriza nada");
  assert.throws(() => recordReviewVerdict(d, PR, approveJson("abc"), "abc", false), /40 hex/);
  assert.throws(() => reviewFile(d, { ...PR, owner: "../x" }, HEAD), /inválid/);
});

test("approve escrito no taskDir do worker não autoriza nada: só o store do hook vale", () => {
  const task = dir();
  writeFileSync(join(task, "review.json"), approveJson(HEAD));
  assert.equal(readReview(dir(), PR, HEAD), null);
});

test("saída inválida do subagent vira unverified e não avança o fix loop", () => {
  const d = dir();
  recordReviewVerdict(d, PR, "não é json", HEAD, false);
  const fix = fixStore();
  fix.apply(T_A, { type: "head", head_sha: HEAD });
  const out = fix.apply(T_A, reviewEvent(readReview(d, PR, HEAD)!));
  assert.deepEqual(out.action, { kind: "none" });
});

test("review reprovado manda achados ao worker uma vez; repetição não reenvia", () => {
  const d = dir();
  const fix = fixStore();
  const head = fix.apply(T_A, { type: "head", head_sha: HEAD });
  assert.equal(head.action.kind, "request_review");
  recordReviewVerdict(d, PR, rejectJson(HEAD), HEAD, false);
  const review = readReview(d, PR, HEAD)!;
  const first = fix.apply(T_A, reviewEvent(review)).action;
  assert.equal(first.kind, "send_findings");
  assert.match(findingsText(PR_URL, HEAD, review), /src\/x\.ts:9 \(bloqueante\) falta teste/);
  assert.deepEqual(fix.apply(T_A, reviewEvent(review)).action, { kind: "none" }, "mesmo achado não reenvia");
});

test("novo head reabre o review; veredito antigo não vale no novo head", () => {
  const d = dir();
  const fix = fixStore();
  fix.apply(T_A, { type: "head", head_sha: OLD });
  recordReviewVerdict(d, PR, approveJson(OLD), OLD, false);
  assert.equal(fix.apply(T_A, reviewEvent(readReview(d, PR, OLD)!)).action.kind, "approved");
  assert.equal(readReview(d, PR, HEAD), null, "approve do head antigo não serve ao novo");
  assert.equal(fix.apply(T_A, { type: "head", head_sha: HEAD }).action.kind, "request_review");
});

const ciRun = (): CheckRunFact => ({
  name: "test",
  app_slug: "github-actions",
  head_sha: HEAD,
  status: "COMPLETED",
  conclusion: "SUCCESS",
});

const pr = (): PrSnapshot => ({
  repo: REPO,
  number: 200,
  state: "OPEN",
  is_draft: false,
  head_ref: "feat/x",
  head_sha: HEAD,
  base_ref: "master",
  mergeable: "MERGEABLE",
  merge_state_status: "CLEAN",
  auto_merge_enabled: false,
  linked_issue: 118,
  changed_files: 1,
  files: [{ path: "src/worker/fixture.ts", kind: "modified", additions: 3, deletions: 1 }],
  check_runs: [ciRun()],
});

function githubFake(snap: PrSnapshot | null = pr()) {
  const merges: string[][] = [];
  const github: MergeGithub = {
    snapshot: () =>
      Promise.resolve({
        pr: snap,
        repo: { allow_auto_merge: true, default_branch: "master" },
        protection: { status: "protected", required_contexts: ["test"] },
      }),
    merge: (args) => {
      merges.push(args);
      return Promise.resolve("ok");
    },
  };
  return { github, merges };
}

const request = (
  policy: ReturnType<typeof repoPolicyFor>,
  ticket = ticketFor(T_A),
  review: { head_sha: string; approved: boolean; assessment?: ReviewAssessment | null } = {
    head_sha: HEAD,
    approved: true,
    assessment: ASSESS,
  },
) => ({
  repo: REPO,
  number: 200,
  expected_head_sha: HEAD,
  policy,
  ticket,
  reviewer: null,
  review,
});

test("política padrão é gravada uma vez e fail-closed: review aprovado não gera merge automático", async () => {
  const pol = new MergePolicyStore(dir());
  const policy = repoPolicyFor(pol, REPO, T_A);
  assert.equal(policy?.auto_merge, false);
  assert.ok(pol.load(REPO, null), "default gravada no repositório");
  const { github, merges } = githubFake();
  const res = await requestIntegration(request(policy), { github, store: new IntegrationStore(dir()) });
  assert.notEqual(res.decision, "merge_requested");
  assert.equal(merges.length, 0, "sem autorização e sem escopo: nada é mergeado");
});

test("política existente não é sobrescrita pela default", () => {
  const pol = new MergePolicyStore(dir());
  pol.save({ ...defaultMergePolicy(REPO), auto_merge: true, minimum_risk: "L1" });
  const policy = repoPolicyFor(pol, REPO, T_A);
  assert.equal(pol.load(REPO, null)?.minimum_risk, "L1");
  assert.equal(policy?.minimum_risk, "L1");
});

test("review aprovado + autorização + escopo: pede merge uma vez; repetição não repete", async () => {
  const pol = new MergePolicyStore(dir());
  pol.save({ ...defaultMergePolicy(REPO), auto_merge: true });
  const base = repoPolicyFor(pol, REPO, T_A)!;
  const policy = { ...base, auto_merge: true, authorization: { granted_by: "user" as const, ticket_id: T_A } };
  const ticket = { ...ticketFor(T_A), branch: "feat/x", allowed_paths: ["src/"] };
  const { github, merges } = githubFake();
  const store = new IntegrationStore(dir());
  const first = await requestIntegration(request(policy, ticket), { github, store });
  assert.equal(first.decision, "merge_requested");
  const again = await requestIntegration(request(policy, ticket), { github, store });
  assert.notEqual(again.decision, "merge_requested");
  assert.equal(merges.length, 1, "merge pedido exatamente uma vez");
});

test("review reprovado ou de outro head bloqueia o merge mesmo com autorização", async () => {
  const pol = new MergePolicyStore(dir());
  const base = repoPolicyFor(pol, REPO, T_A)!;
  const policy = { ...base, auto_merge: true, authorization: { granted_by: "user" as const, ticket_id: T_A } };
  const ticket = { ...ticketFor(T_A), branch: "feat/x", allowed_paths: ["src/"] };
  for (const review of [
    { head_sha: HEAD, approved: false },
    { head_sha: OLD, approved: true, assessment: ASSESS },
  ]) {
    const { github, merges } = githubFake();
    const res = await requestIntegration(request(policy, ticket, review), {
      github,
      store: new IntegrationStore(dir()),
    });
    assert.notEqual(res.decision, "merge_requested");
    assert.equal(merges.length, 0);
  }
});

test("PR A aprovada e mergeada inicia B uma vez; mergeada de novo não reabre nada", () => {
  const store = new PlanStore(dir(), () => "2026-11-24T00:00:00.000Z");
  store.create("entrega", "Entrega", [
    { title: "A", delegate },
    { title: "B", depends_on: ["1"], delegate },
  ]);
  store.act("entrega", "approve");
  store.reserve("entrega", "1");
  store.launched("entrega", "1", T_A);
  store.recordDelivery({ name: "pr_open", task_id: T_A, pr: PR_URL, head_sha: HEAD });
  store.recordDelivery({ name: "merge_eligible", task_id: T_A, head_sha: HEAD });
  assert.deepEqual(launchable(store.show("entrega")), [], "aprovada e não mergeada: B não sai");
  assert.deepEqual(store.markMerged(T_A), [{ plan: "entrega", item: "1" }]);
  assert.deepEqual(
    launchable(store.show("entrega")).map((i) => i.id),
    ["2"],
  );
  store.reserve("entrega", "2");
  assert.deepEqual(store.markMerged(T_A), [], "evento duplicado de merge não relança");
  assert.deepEqual(launchable(store.show("entrega")), [], "B reservada: não sai de novo");
});

test("encadeamento do checkPr: PR aberta -> review -> merge_eligible -> merged -> B lança uma vez", async () => {
  const d = dir();
  const fix = fixStore();
  const plans = new PlanStore(dir(), () => "2026-11-24T00:00:00.000Z");
  plans.create("entrega", "Entrega", [
    { title: "A", delegate },
    { title: "B", depends_on: ["1"], delegate },
  ]);
  plans.act("entrega", "approve");
  plans.reserve("entrega", "1");
  plans.launched("entrega", "1", T_A);

  const pol = new MergePolicyStore(dir());
  pol.save({ ...defaultMergePolicy(REPO), auto_merge: true });
  const base = repoPolicyFor(pol, REPO, T_A)!;
  const policy = { ...base, auto_merge: true, authorization: { granted_by: "user" as const, ticket_id: T_A } };
  const ticket = { ...ticketFor(T_A), branch: "feat/x", allowed_paths: ["src/"] };

  const { github, merges } = githubFake();
  const prState: PrState = {
    number: 200,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefOid: HEAD,
    checks: [],
  };
  const gh: MergeGithub = {
    ...github,
    merge: async (args) => {
      await github.merge(args);
      prState.state = "MERGED";
      return "ok";
    },
  };
  const integ = new IntegrationStore(dir());

  assert.equal(prVerdict(prState), "open");
  plans.recordDelivery({ name: "pr_open", task_id: T_A, pr: PR_URL, head_sha: HEAD });
  const head = fix.apply(T_A, { type: "head", head_sha: HEAD });
  assert.equal(head.action.kind, "request_review");
  assert.equal(
    fix.apply(T_A, { type: "head", head_sha: HEAD }).action.kind,
    "none",
    "mesmo head não pede review de novo",
  );

  recordReviewVerdict(d, PR, approveJson(HEAD), HEAD, false);
  const review = readReview(d, PR, HEAD)!;
  assert.equal(fix.apply(T_A, reviewEvent(review)).action.kind, "approved");
  const result = await requestIntegration(
    {
      repo: REPO,
      number: 200,
      expected_head_sha: HEAD,
      policy,
      ticket,
      reviewer: null,
      review: { head_sha: HEAD, approved: true, assessment: ASSESS },
    },
    { github: gh, store: integ },
  );
  assert.equal(result.decision, "merge_requested");
  plans.recordDelivery({ name: "merge_eligible", task_id: T_A, head_sha: HEAD });
  assert.deepEqual(launchable(plans.show("entrega")), [], "merge pedido mas não confirmado: B não sai");

  assert.equal(merges.length, 1, "merge pedido exatamente uma vez");
  assert.equal(prVerdict(prState), "merged");
  fix.apply(T_A, { type: "revoke", reason: "PR mergeada" });
  assert.deepEqual(plans.markMerged(T_A), [{ plan: "entrega", item: "1" }]);
  plans.recordDelivery({ name: "merged", task_id: T_A, pr: PR_URL });
  const next = launchable(plans.show("entrega"));
  assert.deepEqual(
    next.map((i) => i.id),
    ["2"],
  );
  plans.reserve("entrega", "2");
  plans.launched("entrega", "2", "t-bbbbbbbb");

  assert.deepEqual(plans.markMerged(T_A), []);
  assert.deepEqual(launchable(plans.show("entrega")), []);
  assert.equal(plans.show("entrega").items[1]?.task_id, "t-bbbbbbbb");
  assert.equal(merges.length, 1);
});

const scopedTicket = { id: T_A, state: "running" as const, branch: "feat/x", allowed_paths: ["src/"] };
const authorizedPolicy = () => {
  const pol = new MergePolicyStore(dir());
  pol.save({ ...defaultMergePolicy(REPO), auto_merge: true });
  const base = repoPolicyFor(pol, REPO, T_A)!;
  return { ...base, auto_merge: true, authorization: { granted_by: "user" as const, ticket_id: T_A } };
};
const decideFor = (policy: ReturnType<typeof repoPolicyFor>, ticket: typeof scopedTicket, snap: PrSnapshot = pr()) =>
  decideIntegration({
    policy,
    ticket,
    pr: snap,
    repo: { allow_auto_merge: true, default_branch: "master" },
    protection: { status: "protected", required_contexts: ["test"] },
    reviewer: null,
    review: { head_sha: HEAD, approved: true, assessment: ASSESS },
    expected_head_sha: HEAD,
  });

test("ticketFacts: paths vêm dos arquivos do plano da tarefa", () => {
  const taskDir = dir();
  writeFileSync(
    join(taskDir, "implementation-plan.json"),
    JSON.stringify({ task_id: T_A, steps: [{ files: ["src/a.ts", "src/b.ts", "../outside.ts", "/tmp/no.ts"] }] }),
  );
  const task = (status: TaskRecord["status"], branch: string | null) =>
    ({ task_id: T_A, status, branch, task_dir: taskDir }) as TaskRecord;
  assert.deepEqual(ticketFacts(task("running", "feat/x")), {
    id: T_A,
    state: "running",
    branch: "feat/x",
    allowed_paths: ["src/a.ts", "src/b.ts"],
  });
  assert.equal(ticketFacts(task("cancelled", "feat/x")).state, "cancelled");
  assert.equal(ticketFacts(task("done", null)).branch, null);
});

test("integration: o plano autoriza paths declarados e bloqueia alteração fora deles", async () => {
  const taskDir = dir();
  writeFileSync(
    join(taskDir, "implementation-plan.json"),
    JSON.stringify({ task_id: T_A, steps: [{ files: ["src/worker/"] }] }),
  );
  const ticket = ticketFacts({ task_id: T_A, task_dir: taskDir, status: "done", branch: "feat/x" } as TaskRecord);
  const inside = await requestIntegration(request(authorizedPolicy(), ticket), {
    github: githubFake({ ...pr(), files: [{ ...pr().files[0]!, path: "src/worker/change.ts" }] }).github,
    store: new IntegrationStore(dir()),
  });
  assert.ok(
    !inside.reasons.some((r) => ["scope_undefined", "scope_drift"].includes(r.code)),
    JSON.stringify({ ticket, reasons: inside.reasons }),
  );
  const outside = await requestIntegration(request(authorizedPolicy(), ticket), {
    github: githubFake({ ...pr(), files: [{ ...pr().files[0]!, path: "test/change.ts" }] }).github,
    store: new IntegrationStore(dir()),
  });
  assert.ok(
    outside.reasons.some((r) => r.code === "scope_drift"),
    JSON.stringify(outside.reasons),
  );
});

test("runtime sem escopo declarado: review aprovado e autorizado não pede merge", async () => {
  const { github, merges } = githubFake();
  const ticket = ticketFacts({ task_id: T_A, status: "done", branch: "feat/x" } as TaskRecord);
  const res = await requestIntegration(request(authorizedPolicy(), ticket), {
    github,
    store: new IntegrationStore(dir()),
  });
  assert.equal(res.decision, "blocked");
  assert.ok(
    res.reasons.some((r) => r.code === "scope_undefined"),
    JSON.stringify(res.reasons),
  );
  assert.equal(merges.length, 0);
});

test("ticket cancelado no runtime: ticket_inactive e nenhum merge", async () => {
  const { github, merges } = githubFake();
  const ticket = ticketFacts({ task_id: T_A, status: "cancelled", branch: "feat/x" } as TaskRecord);
  const res = await requestIntegration(request(authorizedPolicy(), ticket), {
    github,
    store: new IntegrationStore(dir()),
  });
  assert.ok(
    res.reasons.some((r) => r.code === "ticket_inactive"),
    JSON.stringify(res.reasons),
  );
  assert.equal(merges.length, 0);
});

test("integrationRoute: merge pedido ou já pedido segue o fluxo de merge", () => {
  const fresh = decideFor(authorizedPolicy(), scopedTicket);
  assert.equal(fresh.decision, "merge_requested");
  assert.deepEqual(integrationRoute(fresh), { kind: "merge_requested" });
  const already = decideFor(authorizedPolicy(), scopedTicket, { ...pr(), auto_merge_enabled: true });
  assert.equal(already.decision, "already_requested");
  assert.deepEqual(integrationRoute(already), { kind: "merge_requested" });
});

test("integrationRoute: draft e PR sem issue (corrigíveis) vão ao worker", () => {
  const draft = decideFor(authorizedPolicy(), scopedTicket, { ...pr(), is_draft: true });
  assert.deepEqual(integrationRoute(draft), { kind: "ask_worker", reasons: ["PR em draft"] });
  const noIssue = decideFor(authorizedPolicy(), scopedTicket, { ...pr(), linked_issue: null });
  assert.equal(integrationRoute(noIssue).kind, "ask_worker");
});

test("integrationRoute: escopo ausente (caso real do runtime) vai ao usuário", () => {
  const res = decideFor(authorizedPolicy(), { ...scopedTicket, allowed_paths: [] });
  assert.ok(
    res.reasons.some((r) => r.code === "scope_undefined"),
    JSON.stringify(res.reasons),
  );
  const route = integrationRoute(res);
  assert.equal(route.kind, "ask_user");
  assert.equal(route.kind === "ask_user" && route.manual, false);
});

test("integrationRoute: manual_approval vai ao usuário marcado como aprovação humana", () => {
  const res = decideFor(repoPolicyFor(new MergePolicyStore(dir()), REPO, T_A), scopedTicket);
  assert.equal(res.decision, "manual_approval");
  assert.deepEqual(integrationRoute(res), {
    kind: "ask_user",
    reasons: ["sem autorização explícita de auto-merge"],
    manual: true,
  });
});
