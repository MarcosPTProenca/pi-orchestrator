import { join } from "node:path";
import { FakeHerdr } from "../../test/fakes.ts";
import { deliveryFromFix, type DeliveryEvent } from "../../src/orchestrator/delivery.ts";
import { FixLoopStore, type FixAction, type FixEvent } from "../../src/orchestrator/fix-loop.ts";
import { PlanStore } from "../../src/orchestrator/plans.ts";
import { IntegrationStore, requestIntegration, type IntegrationResult } from "../../src/shared/merge-gate.ts";
import {
  defaultMergePolicy,
  type ChangedFile,
  type MergePolicy,
  type TicketFacts,
} from "../../src/shared/merge-policy.ts";
import { summarizeTurns, type TurnRecord } from "../../src/shared/usage.ts";
import { ReviewCoordinator, type ReviewRequest, type ReviewResult } from "../../src/shared/review.ts";
import { reviewAssessment } from "../../src/orchestrator/review-verdict.ts";
import type { ReviewAssessment } from "../../src/shared/merge-policy.ts";
import { BRANCH, FakeGithub, PR_NUMBER, PR_URL, REPO, REVIEWER, sha } from "./fakes.ts";

export const TASK = "t-0148a001";
const TICKET_ID = "t-148";
const PLAN_ID = "plano-148";
export const WORKER = "w1:p2";
const CLOCK = "2026-11-23T12:00:00.000Z";
const ALLOWED = ["docs/", "src/", "test/"];
const MAX_STEPS = 40;
const MAX_TICKS = 3;
const DELEGATE = {
  project_path: "/fake/projeto",
  request: "implementar item do plano",
  objective: "objetivo simulado",
  mode: "direct-pr" as const,
};

type CiConclusion = "SUCCESS" | "FAILURE" | "TIMED_OUT";
type Verdict = "approve" | "request_changes" | "reject" | "unverified";
interface ReviewScript {
  verdict: Verdict;
  blocking: number;
}
type Terminal = "merged" | "merge_unconfirmed" | "blocked" | "manual_approval" | "stalled";

export interface Scenario {
  id: string;
  title: string;
  expectMerge: boolean;
  files: ChangedFile[];
  ci: CiConclusion[];
  reviews: ReviewScript[];
  fixFiles?: ChangedFile[][];
  allowedPaths?: string[];
  policy?: MergePolicy | null;
  maxAttempts?: number;
  mergeDelayTicks?: number;
  duplicateEvent?: boolean;
  failMerge?: boolean;
  raceHeadOnMerge?: boolean;
  withPlan?: boolean;
}

export interface RunResult {
  id: string;
  expect_merge: boolean;
  terminal: Terminal;
  reason: string | null;
  transitions: string[];
  heads: string[];
  reviews: { head: string; verdict: string }[];
  ci: { head: string; conclusion: CiConclusion }[];
  rework: number;
  prompt_targets: string[];
  redeliveries: string[];
  integrations: { decision: string; codes: string[] }[];
  advanced_at_tick: number | null;
  ready_per_tick: string[][];
  turns: TurnRecord[];
  github: FakeGithub;
  stateDir: string;
}

const SIMULATED_COST_PER_ROLE = {
  planner: { model: "openai-codex/gpt-6.1-sol", tokens: 30_000, cost: 0.12, ms: 90_000 },
  implementer: { model: "claude-bridge/claude-haiku-5-5", tokens: 80_000, cost: 0.3, ms: 240_000 },
  reviewer: { model: "openai-codex/gpt-6.1-sol", tokens: 20_000, cost: 0.05, ms: 40_000 },
};

type Role = keyof typeof SIMULATED_COST_PER_ROLE;

function roleTurn(role: Role): TurnRecord {
  const c = SIMULATED_COST_PER_ROLE[role];
  return {
    trigger: "automatico",
    provider: "simulado",
    model: c.model,
    durationMs: c.ms,
    ok: true,
    totalTokens: c.tokens,
    cost: c.cost,
  };
}

export function openStores(stateDir: string, maxAttempts: number) {
  return {
    fix: new FixLoopStore(join(stateDir, "fix-loop.json"), { maxAttempts, now: () => CLOCK }),
    integ: new IntegrationStore(join(stateDir, "integration")),
    plans: new PlanStore(join(stateDir, "plans"), () => CLOCK),
  };
}

export function authorizedPolicy(): MergePolicy {
  return {
    ...defaultMergePolicy(REPO, TICKET_ID),
    auto_merge: true,
    authorization: { granted_by: "user", ticket_id: TICKET_ID },
  };
}

export function ticketFacts(allowed: string[] = ALLOWED): TicketFacts {
  return { id: TICKET_ID, state: "running", branch: BRANCH, allowed_paths: allowed };
}

const APPROVED_ASSESSMENT: ReviewAssessment = {
  level: "L0",
  category: "revisão simulada",
  reason: "parecer de fixture do harness",
  confidence: "high",
  requires_human_judgment: false,
  scope_drift: false,
};

export function integrationParams(
  head: string,
  policy: MergePolicy | null = authorizedPolicy(),
  allowed?: string[],
  assessment: ReviewAssessment | null = APPROVED_ASSESSMENT,
) {
  return {
    repo: REPO,
    number: PR_NUMBER,
    expected_head_sha: head,
    policy,
    ticket: ticketFacts(allowed),
    reviewer: null,
    review: { head_sha: head, approved: true, assessment },
  };
}

function reviewRequest(head: string): ReviewRequest {
  return {
    repo: REPO,
    pr_url: PR_URL,
    issue_url: `https://github.com/${REPO}/issues/148`,
    implementation_plan: "plano simulado",
    acceptance: ["AC-1: o defeito reproduzido pelo teste deixa de ocorrer"],
    base_sha: sha(0),
    head_sha: head,
    diff: "diff simulado",
    ci_status: "test: SUCCESS",
    prior_reviews: [],
    project_instructions: [],
  };
}

function reviewJson(head: string, s: ReviewScript): string {
  return JSON.stringify({
    schema_version: 2,
    verdict: s.verdict,
    reviewed_sha: head,
    risk_assessment: {
      level: "L0",
      category: "revisão simulada",
      reason: "parecer de fixture do harness",
      evidence: ["test/pipeline.test.ts:1"],
      confidence: "high",
    },
    requires_human_judgment: false,
    scope_drift: false,
    criteria: [{ id: "AC-1", status: s.verdict === "approve" ? "pass" : "fail", evidence: "test/pipeline.test.ts:1" }],
    findings: Array.from({ length: s.blocking }, (_, i) => ({
      file: "src/orchestrator/fix-loop.ts",
      line: i + 1,
      cause: "defeito real simulado",
      blocking: true,
    })),
    suggestions: [],
  });
}

function at<T>(list: T[], i: number): T {
  return list[Math.min(i, list.length - 1)];
}

const label = (h: string): string => h.slice(-4);

function eventLabel(ev: DeliveryEvent): string {
  return `${ev.name}@${label(ev.head_sha ?? "")}`;
}

function openPlan(plans: PlanStore): void {
  plans.create(PLAN_ID, "Plano de teste do pipeline", [
    { title: "item A", delegate: DELEGATE },
    { title: "item B", depends_on: ["1"], delegate: DELEGATE },
  ]);
  plans.act(PLAN_ID, "approve");
  plans.launched(PLAN_ID, "1", TASK);
}

function readyNames(plans: PlanStore, withPlan: boolean): string[] {
  if (!withPlan) return [];
  return plans.ready(plans.show(PLAN_ID)).map((i) => i.id);
}

export async function runDelivery(sc: Scenario, stateDir: string): Promise<RunResult> {
  const github = new FakeGithub(sha(1), sc.files);
  github.mergeDelayTicks = sc.mergeDelayTicks ?? 1;
  github.failNextMerge = sc.failMerge ?? false;
  const { fix, integ, plans } = openStores(stateDir, sc.maxAttempts ?? 2);
  const herdr = new FakeHerdr();
  const policy = sc.policy === undefined ? authorizedPolicy() : sc.policy;
  const allowed = sc.allowedPaths ?? ALLOWED;
  let raw = "";
  const reviewer = new ReviewCoordinator({ runner: () => raw, timeoutMs: 60_000, newRunId: () => "review-sim" });
  if (sc.withPlan) openPlan(plans);

  const turns: TurnRecord[] = [roleTurn("planner"), roleTurn("implementer")];
  const transitions: string[] = [];
  const reviews: RunResult["reviews"] = [];
  let assessment: ReviewAssessment | null = null;
  const ci: RunResult["ci"] = [];
  const integrations: RunResult["integrations"] = [];
  const redeliveries: string[] = [];
  const readyPerTick: string[][] = [];
  const heads = [sha(1)];
  let head = sha(1);
  let fixes = 0;
  let ciRound = 0;
  let reviewRound = 0;
  let advancedAt: number | null = null;
  let terminal: Terminal = "stalled";
  let reason: string | null = "sem ação pendente";

  plans.recordDelivery({ name: "pr_open", task_id: TASK, pr: PR_URL, head_sha: head });
  transitions.push(`pr_open@${label(head)}`);
  let action: FixAction = fix.apply(TASK, { type: "head", head_sha: head }).action;

  for (let step = 0; step < MAX_STEPS; step++) {
    const ev = deliveryFromFix(action, TASK);
    if (ev) {
      plans.recordDelivery(ev);
      transitions.push(eventLabel(ev));
    }
    if (action.kind === "none") {
      terminal = "stalled";
      reason = "revisão sem veredito conclusivo: nenhuma ação, nada avança";
      break;
    }
    if (action.kind === "blocked") {
      terminal = "blocked";
      reason = action.reason;
      break;
    }
    if (action.kind === "request_review") {
      const conclusion = at(sc.ci, ciRound++);
      ci.push({ head, conclusion });
      github.setCheck({ name: "test", app_slug: "github-actions", head_sha: head, status: "COMPLETED", conclusion });
      if (conclusion !== "SUCCESS") {
        action = fix.apply(TASK, { type: "ci_red", head_sha: head, checks: ["test"] }).action;
        continue;
      }
      const script = at(sc.reviews, reviewRound++);
      turns.push(roleTurn("reviewer"));
      raw = reviewJson(head, script);
      const result: ReviewResult = await reviewer.request(reviewRequest(head));
      assessment = reviewAssessment(result);
      reviews.push({ head, verdict: result.verdict });
      if (result.verdict !== "unverified") {
        github.setCheck({
          name: REVIEWER.check_name,
          app_slug: REVIEWER.app_slug,
          head_sha: head,
          status: "COMPLETED",
          conclusion: result.verdict === "approve" ? "SUCCESS" : "FAILURE",
        });
      }
      const event: FixEvent = {
        type: "review",
        head_sha: head,
        verdict: result.verdict,
        blocking: result.findings.filter((f) => f.blocking).length,
      };
      action = fix.apply(TASK, event).action;
      if (sc.duplicateEvent) redeliveries.push(fix.apply(TASK, event).action.kind);
      continue;
    }
    if (action.kind === "send_findings" || action.kind === "send_ci_fix") {
      fixes++;
      turns.push(roleTurn("implementer"));
      await herdr.prompt(
        WORKER,
        action.kind === "send_findings" ? "corrija os achados bloqueantes" : "corrija a falha de CI",
      );
      head = sha(fixes + 1);
      heads.push(head);
      github.pushHead(head, at(sc.fixFiles ?? [sc.files], fixes - 1));
      action = fix.apply(TASK, { type: "head", head_sha: head }).action;
      continue;
    }
    if (action.kind === "approved") {
      if (sc.raceHeadOnMerge) github.raceHeadOnMerge = sha(99);
      const params = integrationParams(head, policy, allowed, assessment);
      const first = await requestIntegration(params, { github, store: integ });
      integrations.push(summarize(first));
      if (sc.duplicateEvent) integrations.push(summarize(await requestIntegration(params, { github, store: integ })));
      if (first.decision !== "merge_requested") {
        terminal = first.decision === "manual_approval" ? "manual_approval" : "blocked";
        reason = first.reasons.map((r) => r.message).join("; ") || first.decision;
        break;
      }
      for (let tick = 1; tick <= MAX_TICKS && advancedAt === null; tick++) {
        github.tick();
        const snap = await github.snapshot();
        if (snap.pr?.state === "MERGED") {
          plans.recordDelivery({ name: "merged", task_id: TASK, pr: PR_URL });
          plans.markMerged(TASK);
          advancedAt = tick;
          transitions.push(`merged@${label(head)}`);
        }
        readyPerTick.push(readyNames(plans, sc.withPlan === true));
      }
      terminal = advancedAt === null ? "merge_unconfirmed" : "merged";
      reason = advancedAt === null ? "pedido de auto-merge sem confirmação do GitHub" : null;
      break;
    }
  }

  return {
    id: sc.id,
    expect_merge: sc.expectMerge,
    terminal,
    reason,
    transitions,
    heads,
    reviews,
    ci,
    rework: fixes,
    prompt_targets: herdr.opsOf("prompt").map((c) => (c.args as { target: string }).target),
    redeliveries,
    integrations,
    advanced_at_tick: advancedAt,
    ready_per_tick: readyPerTick,
    turns,
    github,
    stateDir,
  };
}

function summarize(r: IntegrationResult): { decision: string; codes: string[] } {
  return { decision: r.decision, codes: r.reasons.map((x) => x.code) };
}

export function aggregate(results: RunResult[]) {
  const withReview = results.filter((r) => r.reviews.length > 0);
  const all = summarizeTurns(results.flatMap((r) => r.turns));
  return {
    scenarios: results.length,
    merged: results.filter((r) => r.terminal === "merged").length,
    improper_merges: results.filter((r) => r.terminal === "merged" && !r.expect_merge).length,
    missed_merges: results.filter((r) => r.terminal !== "merged" && r.expect_merge).length,
    first_review_approval: {
      approved: withReview.filter((r) => r.reviews[0].verdict === "approve").length,
      of: withReview.length,
    },
    rework_cycles: results.reduce((s, r) => s + r.rework, 0),
    human_stops: results.filter((r) => r.terminal !== "merged").length,
    llm_turns: all.turns,
    cost_simulated: all.cost,
    duration_ms_simulated: all.duration_ms_total,
    tokens_simulated: results.flatMap((r) => r.turns).reduce((s, t) => s + t.totalTokens, 0),
  };
}
