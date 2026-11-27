import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MERGE_POLICY_SCHEMA_VERSION = 1;
const RISK_LEVELS = ["L0", "L1", "L2", "L3"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
type GateDecision = "eligible" | "manual_approval" | "blocked";
type ChangeKind = "added" | "modified" | "deleted" | "renamed";

interface MergeAuthorization {
  granted_by: "user" | null;
  ticket_id: string | null;
}

export interface MergePolicy {
  schema_version: number;
  version: number;
  repo: string;
  ticket_id: string | null;
  auto_merge: boolean;
  minimum_risk: RiskLevel;
  protected_paths: string[];
  authorization: MergeAuthorization;
}

export interface ChangedFile {
  path: string;
  kind: ChangeKind;
  additions: number;
  deletions: number;
}

interface FileRisk {
  path: string;
  risk: RiskLevel;
  reason: string;
}

export interface RiskClassification {
  risk: RiskLevel;
  files: FileRisk[];
  reasons: string[];
}

interface GateReason {
  code: string;
  message: string;
}

export interface TicketFacts {
  id: string;
  state: "running" | "done" | "paused" | "cancelled";
  branch: string | null;
  allowed_paths: string[];
}

interface PrFacts {
  repo: string;
  number: number;
  head_branch: string | null;
  head_sha: string;
  linked_issue: number | null;
}

export interface ReviewAssessment {
  level: RiskLevel;
  category: string;
  reason: string;
  confidence: "high" | "medium" | "low" | "unverified";
  requires_human_judgment: boolean;
  scope_drift: boolean;
}

export interface MergeGateInput {
  policy: MergePolicy | null;
  ticket: TicketFacts | null;
  pr: PrFacts | null;
  diff: ChangedFile[] | null;
  checks: { head_sha: string; all_green: boolean } | null;
  review: { head_sha: string; fresh_approval: boolean; assessment: ReviewAssessment | null } | null;
}

export interface MergeGateResult {
  decision: GateDecision;
  risk: RiskLevel | null;
  policy_version: string | null;
  reasons: GateReason[];
  evidence: { head_sha: string | null; files: FileRisk[] };
}

const MAX_FILES_LOCAL = 10;
const MAX_LINES_LOCAL = 400;
const REPO_RE = /^[A-Za-z0-9_-][\w.-]*\/[A-Za-z0-9_-][\w.-]*$/;
const TICKET_RE = /^[A-Za-z0-9._-]{1,80}$/;

interface Rule {
  risk: RiskLevel;
  re: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  { risk: "L3", re: /^\.github\//, reason: "CI ou permissões de workflow" },
  { risk: "L3", re: /(^|\/)\.env(\.|$)|secret|credential|\.(pem|key|p12)$/, reason: "segredo ou credencial" },
  {
    risk: "L3",
    re: /(^|\/)(auth|authn|authz|oauth|login|payments?|billing|checkout)(\/|[-_.]|$)/,
    reason: "auth ou pagamento",
  },
  { risk: "L3", re: /(^|\/)(migrations?|db\/migrate)\/|\.sql$/, reason: "migração de dados" },
  {
    risk: "L3",
    re: /(^|\/)(infra|terraform|deploy|k8s|helm)\/|\.tf$|(^|\/)dockerfile|docker-compose/i,
    reason: "infraestrutura ou deploy",
  },
  {
    risk: "L2",
    re: /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|requirements[^/]*\.txt|go\.(mod|sum)|cargo\.(toml|lock))$/,
    reason: "dependência",
  },
  {
    risk: "L2",
    re: /^src\/shared\/|^src\/index\.ts$|(^|\/)(openapi|schema)[^/]*$|\.proto$/,
    reason: "contrato público ou arquitetura",
  },
  {
    risk: "L0",
    re: /^docs\/|^temp_docs\/|\.md$|^test\/|\.test\.[cm]?[jt]sx?$|(^|\/)__tests__\//,
    reason: "docs ou testes",
  },
];

const rank = (r: RiskLevel): number => RISK_LEVELS.indexOf(r);

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return rank(a) >= rank(b) ? a : b;
}

export function defaultMergePolicy(repo: string, ticketId: string | null = null): MergePolicy {
  return {
    schema_version: MERGE_POLICY_SCHEMA_VERSION,
    version: 1,
    repo,
    ticket_id: ticketId,
    auto_merge: false,
    minimum_risk: "L0",
    protected_paths: [],
    authorization: { granted_by: null, ticket_id: null },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nullableText(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string") throw new Error(`${field} precisa ser texto ou null`);
  return v;
}

export function parseMergePolicy(raw: unknown): MergePolicy {
  if (!isRecord(raw)) throw new Error("merge policy precisa ser um objeto");
  if (raw.schema_version !== MERGE_POLICY_SCHEMA_VERSION) {
    throw new Error(`versão de schema incompatível: ${String(raw.schema_version)}`);
  }
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    throw new Error("version inválida");
  }
  if (typeof raw.repo !== "string" || !REPO_RE.test(raw.repo)) throw new Error("repo inválido");
  const ticketId = nullableText(raw.ticket_id, "ticket_id");
  if (ticketId !== null && !TICKET_RE.test(ticketId)) throw new Error("ticket_id inválido");
  if (typeof raw.auto_merge !== "boolean") throw new Error("auto_merge precisa ser booleano");
  if (typeof raw.minimum_risk !== "string" || !(RISK_LEVELS as readonly string[]).includes(raw.minimum_risk)) {
    throw new Error("minimum_risk inválido");
  }
  const protectedPaths = raw.protected_paths;
  if (!Array.isArray(protectedPaths) || !protectedPaths.every((p) => typeof p === "string")) {
    throw new Error("protected_paths precisa ser lista de strings");
  }
  if (!isRecord(raw.authorization)) throw new Error("authorization precisa ser objeto");
  const grantedBy = raw.authorization.granted_by;
  if (grantedBy !== "user" && grantedBy !== null) throw new Error("granted_by inválido");
  return {
    schema_version: MERGE_POLICY_SCHEMA_VERSION,
    version: raw.version,
    repo: raw.repo,
    ticket_id: ticketId,
    auto_merge: raw.auto_merge,
    minimum_risk: raw.minimum_risk as RiskLevel,
    protected_paths: [...protectedPaths],
    authorization: {
      granted_by: grantedBy,
      ticket_id: nullableText(raw.authorization.ticket_id, "authorization.ticket_id"),
    },
  };
}

export function resolveMergePolicy(
  repo: MergePolicy | null,
  ticketId: string,
  ticket: MergePolicy | null,
): MergePolicy | null {
  if (!repo) return null;
  if (ticket && (ticket.ticket_id !== ticketId || ticket.repo !== repo.repo)) return null;
  const t = ticket ?? defaultMergePolicy(repo.repo, ticketId);
  return {
    ...t,
    repo: repo.repo,
    ticket_id: ticketId,
    auto_merge: repo.auto_merge && t.auto_merge,
    minimum_risk: maxRisk(repo.minimum_risk, t.minimum_risk),
    protected_paths: [...new Set([...repo.protected_paths, ...t.protected_paths])],
    authorization: t.authorization,
  };
}

export function policyVersion(policy: MergePolicy): string {
  const { version, ...content } = policy;
  const digest = createHash("sha256")
    .update(JSON.stringify(sortKeys(content)))
    .digest("hex")
    .slice(0, 12);
  return `v${version}-${digest}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys(value[k])]),
  );
}

export class MergePolicyStore {
  constructor(private readonly dir: string) {}

  private fileOf(repo: string, ticketId: string | null): string {
    if (!REPO_RE.test(repo)) throw new Error("repo inválido");
    if (ticketId !== null && !TICKET_RE.test(ticketId)) throw new Error("ticket_id inválido");
    return join(this.dir, `${encodeURIComponent(repo)}__${ticketId ?? "_repo"}.json`);
  }

  load(repo: string, ticketId: string | null): MergePolicy | null {
    const file = this.fileOf(repo, ticketId);
    if (!existsSync(file)) return null;
    return parseMergePolicy(JSON.parse(readFileSync(file, "utf8")));
  }

  save(policy: Omit<MergePolicy, "version">): MergePolicy {
    const previous = this.load(policy.repo, policy.ticket_id);
    const next = parseMergePolicy({ ...policy, version: (previous?.version ?? 0) + 1 });
    mkdirSync(this.dir, { recursive: true });
    const file = this.fileOf(next.repo, next.ticket_id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, file);
    return next;
  }
}

function normalizePath(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  if (p === "" || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  if (p.split("/").some((seg) => seg === ".." || seg === "")) return null;
  return p;
}

function riskOf(file: ChangedFile, protectedPaths: string[]): FileRisk {
  const path = normalizePath(file.path);
  if (path === null) return { path: file.path, risk: "L3", reason: "caminho inválido" };
  const lower = path.toLowerCase();
  const extra = protectedPaths.find((p) => lower.startsWith(p.replace(/\\/g, "/").toLowerCase()));
  if (extra !== undefined) return { path, risk: "L3", reason: `caminho protegido pela política: ${extra}` };
  const rule = RULES.find((r) => r.re.test(lower));
  if (rule) return { path, risk: rule.risk, reason: rule.reason };
  if (file.kind === "deleted" || file.kind === "renamed") {
    return { path, risk: "L2", reason: "remoção ou renomeação" };
  }
  return { path, risk: "L1", reason: "mudança localizada" };
}

export function classifyRisk(
  files: ChangedFile[],
  policy: Pick<MergePolicy, "protected_paths" | "minimum_risk">,
): RiskClassification {
  const fileRisks = files.map((f) => riskOf(f, policy.protected_paths));
  const reasons: string[] = [];
  let risk = fileRisks.reduce<RiskLevel>((acc, f) => maxRisk(acc, f.risk), "L0");
  const lines = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (files.length > MAX_FILES_LOCAL || lines > MAX_LINES_LOCAL) {
    reasons.push(`mudança ampla: ${files.length} arquivos, ${lines} linhas`);
    risk = maxRisk(risk, "L2");
  }
  if (fileRisks.some((f) => f.risk === "L1")) risk = maxRisk(risk, "L1");
  risk = maxRisk(risk, policy.minimum_risk);
  for (const f of fileRisks) if (f.risk !== "L0") reasons.push(`${f.path}: ${f.reason}`);
  return { risk, files: fileRisks, reasons };
}

export function consolidateRisk(staticRisk: RiskLevel, assessment: ReviewAssessment | null): RiskLevel {
  return assessment ? maxRisk(staticRisk, assessment.level) : staticRisk;
}

function usableAssessment(review: MergeGateInput["review"], headSha: string): ReviewAssessment | null {
  if (!review || review.head_sha !== headSha || !review.fresh_approval) return null;
  if (!review.assessment || review.assessment.confidence === "unverified") return null;
  return review.assessment;
}

function block(code: string, message: string): GateReason {
  return { code, message };
}

export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
  const { policy, ticket, pr, diff, checks, review } = input;
  const blockers: GateReason[] = [];
  const policyVer = policy ? policyVersion(policy) : null;
  let classification: RiskClassification | null = null;

  if (!policy) blockers.push(block("policy_unavailable", "política indisponível"));
  if (!ticket) blockers.push(block("ticket_unknown", "ticket desconhecido"));
  else if (ticket.state === "paused" || ticket.state === "cancelled") {
    blockers.push(block("ticket_inactive", `ticket ${ticket.state}`));
  }
  if (policy && ticket && policy.ticket_id !== ticket.id) {
    blockers.push(block("policy_ticket_mismatch", "política de outro ticket"));
  }
  if (!pr) blockers.push(block("pr_unknown", "PR desconhecida"));
  else {
    if (policy && pr.repo !== policy.repo) blockers.push(block("repo_mismatch", "PR de outro repositório"));
    if (pr.linked_issue === null) blockers.push(block("pr_without_issue", "PR sem issue vinculada"));
    if (!ticket?.branch || pr.head_branch !== ticket.branch) {
      blockers.push(block("branch_unknown", "branch da PR não é a do ticket"));
    }
  }
  if (!diff || diff.length === 0) blockers.push(block("diff_unavailable", "diff vazio ou indisponível"));
  else if (policy) {
    try {
      classification = classifyRisk(diff, policy);
    } catch {
      blockers.push(block("classification_failed", "falha ao classificar o diff"));
    }
  }
  if (classification && ticket) {
    if (ticket.allowed_paths.length === 0) blockers.push(block("scope_undefined", "escopo do ticket não definido"));
    for (const f of classification.files) {
      if (!ticket.allowed_paths.some((s) => (s.endsWith("/") ? f.path.startsWith(s) : f.path === s))) {
        blockers.push(block("scope_drift", `fora do escopo: ${f.path}`));
      }
    }
  }
  if (!pr || !checks || checks.head_sha !== pr.head_sha) {
    blockers.push(block("checks_unverified", "checks não correspondem ao head_sha da PR"));
  } else if (!checks.all_green) blockers.push(block("checks_red", "checks não estão verdes"));

  const evidence = { head_sha: pr?.head_sha ?? null, files: classification?.files ?? [] };
  const risk = classification?.risk ?? null;
  if (blockers.length > 0) {
    return { decision: "blocked", risk, policy_version: policyVer, reasons: blockers, evidence };
  }
  if (!policy || !ticket || !classification || !pr) {
    return {
      decision: "blocked",
      risk,
      policy_version: policyVer,
      reasons: [block("incomplete", "fatos incompletos")],
      evidence,
    };
  }

  const reasons: GateReason[] = classification.reasons.map((r) => block("risk_factor", r));
  const assessment = usableAssessment(review, pr.head_sha);
  const finalRisk = consolidateRisk(classification.risk, assessment);
  if (assessment && finalRisk !== classification.risk) {
    reasons.push(
      block(
        "risk_escalated_by_review",
        `revisor elevou risco de ${classification.risk} para ${finalRisk}: ${assessment.category} (${assessment.reason})`,
      ),
    );
  }
  if (finalRisk === "L2" || finalRisk === "L3") {
    return {
      decision: "manual_approval",
      risk: finalRisk,
      policy_version: policyVer,
      reasons: [block("risk_requires_human", `risco ${finalRisk} exige aprovação humana`), ...reasons],
      evidence,
    };
  }
  const authorized =
    policy.auto_merge && policy.authorization.granted_by === "user" && policy.authorization.ticket_id === ticket.id;
  if (!authorized) {
    return {
      decision: "manual_approval",
      risk: finalRisk,
      policy_version: policyVer,
      reasons: [block("no_merge_authorization", "sem autorização explícita de auto-merge")],
      evidence,
    };
  }
  if (!assessment) {
    return {
      decision: "manual_approval",
      risk: finalRisk,
      policy_version: policyVer,
      reasons: [block("review_required", "exige review fresh do head_sha atual com avaliação de risco válida")],
      evidence,
    };
  }
  if (assessment.requires_human_judgment || assessment.scope_drift) {
    const code = assessment.requires_human_judgment ? "reviewer_requires_human" : "reviewer_scope_drift";
    return {
      decision: "manual_approval",
      risk: finalRisk,
      policy_version: policyVer,
      reasons: [block(code, "o revisor pediu julgamento humano"), ...reasons],
      evidence,
    };
  }
  return { decision: "eligible", risk: finalRisk, policy_version: policyVer, reasons, evidence };
}
