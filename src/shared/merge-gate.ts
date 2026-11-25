import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskSecrets } from "./logs.ts";
import {
  evaluateMergeGate,
  type ReviewAssessment,
  policyVersion,
  type ChangedFile,
  type MergePolicy,
  type TicketFacts,
} from "./merge-policy.ts";
import { FAILING } from "./prs.ts";

const REQUIRED_CHECKS = ["test"] as const;
const TRUSTED_CI_APP = "github-actions";

export interface TrustedReviewer {
  app_slug: string;
  check_name: string;
}

export interface CheckRunFact {
  name: string;
  app_slug: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
}

export interface PrSnapshot {
  repo: string;
  number: number;
  state: string;
  is_draft: boolean;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  mergeable: string;
  merge_state_status: string;
  auto_merge_enabled: boolean;
  linked_issue: number | null;
  changed_files: number;
  files: ChangedFile[];
  check_runs: CheckRunFact[];
}

export interface RepoFacts {
  allow_auto_merge: boolean;
  default_branch: string;
}

export type Protection =
  | { status: "protected"; required_contexts: string[] }
  | { status: "unprotected" }
  | { status: "unknown"; error: string };

interface ReviewVerdictInput {
  head_sha: string;
  approved: boolean;
  assessment?: ReviewAssessment | null;
}

export interface IntegrationInput {
  policy: MergePolicy | null;
  ticket: TicketFacts | null;
  pr: PrSnapshot | null;
  repo: RepoFacts | null;
  protection: Protection;
  reviewer: TrustedReviewer | null;
  review?: ReviewVerdictInput | null;
  expected_head_sha: string;
}

type IntegrationDecision =
  "merge_requested" | "already_merged" | "already_requested" | "setup_required" | "manual_approval" | "blocked";

interface IntegrationReason {
  code: string;
  message: string;
}

export interface IntegrationResult {
  decision: IntegrationDecision;
  head_sha: string | null;
  risk: string | null;
  policy_version: string | null;
  reasons: IntegrationReason[];
  setup_steps: string[];
  merge_args: string[] | null;
}

const reason = (code: string, message: string): IntegrationReason => ({ code, message });
const upper = (v: string | null): string => (v ?? "").toUpperCase();

function checkReasons(pr: PrSnapshot): IntegrationReason[] {
  const onHead = pr.check_runs.filter((c) => c.head_sha === pr.head_sha && c.app_slug === TRUSTED_CI_APP);
  const out: IntegrationReason[] = [];
  for (const name of REQUIRED_CHECKS) {
    const runs = onHead.filter((c) => c.name === name);
    if (runs.length === 0) {
      out.push(reason("checks_unverified", `check obrigatório "${name}" ausente no head atual`));
    } else if (runs.some((c) => upper(c.status) !== "COMPLETED")) {
      out.push(reason("checks_pending", `check obrigatório "${name}" ainda em andamento`));
    } else if (runs.some((c) => upper(c.conclusion) !== "SUCCESS")) {
      out.push(reason("check_failed", `check obrigatório "${name}" não passou`));
    }
  }
  for (const c of onHead) {
    if (!(REQUIRED_CHECKS as readonly string[]).includes(c.name) && FAILING.has(upper(c.conclusion))) {
      out.push(reason("check_failed", `check "${c.name}" falhou no head atual`));
    }
  }
  return out;
}

type ReviewState = { kind: "approved" | "rejected" | "pending" | "missing" | "unverified"; message: string };

function verdictState(v: ReviewVerdictInput | null, pr: PrSnapshot): ReviewState {
  if (!v || v.head_sha !== pr.head_sha)
    return { kind: "missing", message: "sem review do head atual (aprovação obsoleta ou ausente)" };
  return v.approved
    ? { kind: "approved", message: "review aprovado no head atual" }
    : { kind: "rejected", message: "revisor reprovou o head atual" };
}

function reviewState(pr: PrSnapshot, reviewer: TrustedReviewer | null): ReviewState {
  if (!reviewer) return { kind: "unverified", message: "nenhum revisor confiável configurado" };
  const runs = pr.check_runs.filter(
    (c) => c.head_sha === pr.head_sha && c.app_slug === reviewer.app_slug && c.name === reviewer.check_name,
  );
  if (runs.length === 0)
    return { kind: "missing", message: "sem review do head atual (aprovação obsoleta ou ausente)" };
  if (runs.some((c) => upper(c.status) !== "COMPLETED"))
    return { kind: "pending", message: "review ainda em andamento" };
  if (runs.some((c) => upper(c.conclusion) !== "SUCCESS"))
    return { kind: "rejected", message: "revisor reprovou o head atual" };
  return { kind: "approved", message: "review aprovado no head atual" };
}

const SETUP_AUTO_MERGE = (repo: string) =>
  `Habilitar "Allow auto-merge" em ${repo} (ação do dono, conta com admin): gh api -X PATCH repos/${repo} -F allow_auto_merge=true, ou Settings > General > Allow auto-merge. Nada foi alterado automaticamente.`;
const SETUP_PROTECTION = (branch: string) =>
  `Criar branch protection em ${branch} exigindo o check obrigatório "${REQUIRED_CHECKS.join('", "')}", PR antes do merge e head atualizado (strict). Ação do dono; nada foi alterado automaticamente.`;

export function decideIntegration(input: IntegrationInput): IntegrationResult {
  const { pr, repo, policy, ticket, protection, reviewer, expected_head_sha } = input;
  const fail = (
    decision: IntegrationDecision,
    reasons: IntegrationReason[],
    extra: Partial<IntegrationResult> = {},
  ): IntegrationResult => ({
    decision,
    head_sha: pr?.head_sha ?? null,
    risk: null,
    policy_version: policy ? policyVersion(policy) : null,
    reasons,
    setup_steps: [],
    merge_args: null,
    ...extra,
  });

  if (!pr) return fail("blocked", [reason("pr_unknown", "PR desconhecida")]);
  if (!repo) return fail("blocked", [reason("repo_unknown", "configuração do repositório indisponível")]);
  if (!policy) return fail("blocked", [reason("policy_unavailable", "política de merge indisponível")]);
  if (protection.status === "unknown") {
    return fail("blocked", [
      reason("protection_unknown", `não consegui ler a proteção da branch: ${protection.error}`),
    ]);
  }
  if (pr.state === "MERGED") return fail("already_merged", [reason("pr_merged", "PR já integrada")]);
  if (pr.state !== "OPEN") return fail("blocked", [reason("pr_not_open", `PR está ${pr.state}`)]);
  if (pr.head_sha !== expected_head_sha) {
    return fail("blocked", [reason("head_divergente", "head atual difere do SHA avaliado: revalidar")]);
  }

  const hard: IntegrationReason[] = [];
  if (pr.is_draft) hard.push(reason("draft", "PR em draft"));
  if (pr.base_ref !== repo.default_branch) {
    hard.push(reason("base_mismatch", `base ${pr.base_ref} diferente de ${repo.default_branch}`));
  }
  if (pr.mergeable !== "MERGEABLE" || pr.merge_state_status !== "CLEAN") {
    hard.push(reason("not_mergeable", `mergeable ${pr.mergeable}, mergeStateStatus ${pr.merge_state_status}`));
  }
  hard.push(...checkReasons(pr));
  const review = input.review !== undefined ? verdictState(input.review, pr) : reviewState(pr, reviewer);
  if (review.kind === "rejected") hard.push(reason("review_rejected", review.message));
  if (hard.length > 0) return fail("blocked", hard);

  const gate = evaluateMergeGate({
    policy,
    ticket,
    pr: {
      repo: pr.repo,
      number: pr.number,
      head_branch: pr.head_ref,
      head_sha: pr.head_sha,
      linked_issue: pr.linked_issue,
    },
    diff: pr.changed_files > pr.files.length ? null : pr.files,
    checks: { head_sha: pr.head_sha, all_green: true },
    review: {
      head_sha: pr.head_sha,
      fresh_approval: review.kind === "approved",
      assessment: input.review?.assessment ?? null,
    },
  });
  const risk = gate.risk;
  if (gate.decision === "blocked") return fail("blocked", gate.reasons, { risk });
  const reviewReasons = review.kind !== "approved" ? [reason("review_unverified", review.message)] : [];
  if (gate.decision === "manual_approval") {
    return fail("manual_approval", [...reviewReasons, ...gate.reasons], { risk });
  }
  if (review.kind !== "approved")
    return fail("manual_approval", [reason("review_unverified", review.message)], { risk });

  const setup: string[] = [];
  if (!repo.allow_auto_merge) setup.push(SETUP_AUTO_MERGE(pr.repo));
  if (protection.status === "unprotected") setup.push(SETUP_PROTECTION(repo.default_branch));
  else if (protection.status === "protected") {
    const missing = REQUIRED_CHECKS.filter((c) => !protection.required_contexts.includes(c));
    if (missing.length > 0) setup.push(SETUP_PROTECTION(repo.default_branch));
  }
  if (setup.length > 0) {
    return fail("setup_required", [reason("setup_required", "configuração do GitHub necessária antes do auto-merge")], {
      risk,
      setup_steps: setup,
    });
  }

  if (pr.auto_merge_enabled) {
    return fail("already_requested", [reason("auto_merge_enabled", "auto-merge já ativo para este head")], { risk });
  }
  return fail("merge_requested", gate.reasons, {
    risk,
    merge_args: [
      "pr",
      "merge",
      String(pr.number),
      "--repo",
      pr.repo,
      "--auto",
      "--squash",
      "--match-head-commit",
      pr.head_sha,
    ],
  });
}

interface IntegrationRecord {
  status: "requesting" | "requested" | "failed";
  head_sha: string;
  gh_output?: string;
  error?: string;
}

type ClaimResult = { claimed: true } | { claimed: false; inFlight: boolean; existing: IntegrationRecord | null };

export class IntegrationStore {
  private readonly active = new Set<string>();

  constructor(readonly dir: string) {}

  pathFor(key: string): string {
    return join(this.dir, `${encodeURIComponent(key)}.json`);
  }

  claim(key: string): ClaimResult {
    mkdirSync(this.dir, { recursive: true });
    const file = this.pathFor(key);
    if (this.active.has(key)) return { claimed: false, inFlight: true, existing: this.read(file) };
    try {
      writeFileSync(file, `${JSON.stringify({ status: "requesting", head_sha: keyHead(key) })}\n`, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return { claimed: false, inFlight: false, existing: this.read(file) };
    }
    this.active.add(key);
    return { claimed: true };
  }

  finish(key: string, record: IntegrationRecord): void {
    const file = this.pathFor(key);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, file);
    this.active.delete(key);
  }

  private read(file: string): IntegrationRecord | null {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as IntegrationRecord;
    } catch {
      return null;
    }
  }
}

function keyHead(key: string): string {
  return key.slice(key.lastIndexOf("@") + 1);
}

export interface MergeSnapshot {
  pr: PrSnapshot | null;
  repo: RepoFacts | null;
  protection: Protection;
}

export interface MergeGithub {
  snapshot(repo: string, number: number): Promise<MergeSnapshot>;
  merge(args: string[]): Promise<string>;
}

export interface RequestParams {
  repo: string;
  number: number;
  expected_head_sha: string;
  policy: MergePolicy | null;
  ticket: TicketFacts | null;
  reviewer: TrustedReviewer | null;
  review?: ReviewVerdictInput | null;
}

export async function requestIntegration(
  params: RequestParams,
  deps: { github: MergeGithub; store: IntegrationStore },
): Promise<IntegrationResult> {
  let snap: MergeSnapshot;
  try {
    snap = await deps.github.snapshot(params.repo, params.number);
  } catch (err) {
    return {
      decision: "blocked",
      head_sha: params.expected_head_sha,
      risk: null,
      policy_version: null,
      reasons: [reason("github_unavailable", maskSecrets(errText(err)).slice(0, 300))],
      setup_steps: [],
      merge_args: null,
    };
  }
  const result = decideIntegration({
    policy: params.policy,
    ticket: params.ticket,
    pr: snap.pr,
    repo: snap.repo,
    protection: snap.protection,
    reviewer: params.reviewer,
    review: params.review,
    expected_head_sha: params.expected_head_sha,
  });
  if (result.decision !== "merge_requested") return result;

  const key = `${params.repo}#${params.number}@${params.expected_head_sha}`;
  const claim = deps.store.claim(key);
  if (!claim.claimed) {
    if (claim.inFlight || claim.existing?.status === "requested") {
      return {
        ...result,
        decision: "already_requested",
        merge_args: null,
        reasons: [reason("integration_already_requested", "pedido de merge já registrado para este head")],
      };
    }
    if (claim.existing?.status === "failed") {
      return {
        ...result,
        decision: "blocked",
        merge_args: null,
        reasons: [
          reason("integration_failed_for_head", "tentativa anterior falhou neste head; revisar antes de repetir"),
        ],
      };
    }
    return {
      ...result,
      decision: "blocked",
      merge_args: null,
      reasons: [reason("integration_interrupted", "pedido anterior ficou sem resultado; reconciliar a PR manualmente")],
    };
  }

  try {
    const out = await deps.github.merge(result.merge_args ?? []);
    deps.store.finish(key, {
      status: "requested",
      head_sha: params.expected_head_sha,
      gh_output: maskSecrets(out).slice(0, 500),
    });
    return result;
  } catch (err) {
    const msg = maskSecrets(errText(err)).slice(0, 300);
    deps.store.finish(key, { status: "failed", head_sha: params.expected_head_sha, error: msg });
    return { ...result, decision: "blocked", merge_args: null, reasons: [reason("merge_request_failed", msg)] };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
