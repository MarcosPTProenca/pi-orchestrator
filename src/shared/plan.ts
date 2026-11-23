import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { ExecutionTicket } from "./execution-ticket.ts";
import { maskSecrets } from "./logs.ts";

const PLAN_SCHEMA_VERSION = 1;
export const TICKET_FILE = "ticket.json";
export const PLAN_FILE = "implementation-plan.json";
const PLAN_MD_FILE = "implementation-plan.md";
export const PHASE_FILE = "plan-phase.json";
const PREFLIGHT_FILE = "preflight.json";

const KINDS = ["bug", "feature", "change"] as const;
const PHASES = ["TICKET_VALIDATED", "PREFLIGHT", "PLAN_READY", "BLOCKED"] as const;
const MAX_STEPS = 12;
const MAX_PLAN_CHARS = 20000;
const VAGUE_CHECKS = new Set([
  "testar tudo",
  "test everything",
  "test all",
  "tudo",
  "testar",
  "rodar testes",
  "run tests",
]);

type PlanKind = (typeof KINDS)[number];
export type Phase = (typeof PHASES)[number];

export interface PhaseState {
  phase: Phase;
  ticket_fingerprint?: string;
  reason?: string;
}

interface PlanStep {
  id: string;
  action: string;
  files: string[];
  verifies: string[];
  check: string;
}

export interface ImplementationPlan {
  schema_version: number;
  task_id: string;
  attempt_id: string;
  ticket_fingerprint: string;
  base_sha: string | null;
  head_sha: string | null;
  kind: PlanKind;
  problem: string;
  diagnosis: { ref: string; note: string }[];
  approach: string;
  rejected_alternatives: { option: string; reason: string }[];
  reproduction: string | null;
  test_seams: { name: string; boundary: string }[];
  steps: PlanStep[];
  criteria: { id: string; covered_by: string[]; evidence: string }[];
  expected_tests: string[];
  risks: string[];
  deviations: string[];
  blockers: string[];
}

export type ValidationResult = { ok: true; plan: ImplementationPlan } | { ok: false; errors: string[] };
export type Reuse = { reuse: true; plan: ImplementationPlan } | { reuse: false; reason: string };

type Rec = Record<string, unknown>;

const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const txt = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const optTxt = (v: unknown): string | null => (txt(v) === "" ? null : txt(v));

export function ticketFingerprint(t: ExecutionTicket): string {
  const content = {
    mode: t.mode,
    project: t.project.id,
    objective: t.objective,
    request: t.request,
    scope: t.scope,
    acceptance: t.acceptance,
    source: t.origin.source,
    validation: t.validation,
  };
  return createHash("sha256").update(canonical(content)).digest("hex");
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    isObj(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val,
  );
}

export type StaleReason = "ticket_changed" | "base_changed";

export function staleReason(plan: ImplementationPlan, ticket: ExecutionTicket): StaleReason | null {
  if (plan.ticket_fingerprint !== ticketFingerprint(ticket)) return "ticket_changed";
  if (plan.base_sha !== ticket.origin.base_sha) return "base_changed";
  return null;
}

function shape(raw: unknown, errs: string[]): ImplementationPlan | null {
  if (!isObj(raw)) {
    errs.push("plano precisa ser um objeto");
    return null;
  }
  const o = raw;
  const req = (field: string): string => {
    const v = txt(o[field]);
    if (v === "") errs.push(`${field} vazio ou ausente`);
    return v;
  };
  const list = (field: string): unknown[] => {
    const v = o[field];
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v;
    errs.push(`${field} precisa ser uma lista`);
    return [];
  };
  const strs = (field: string): string[] =>
    list(field).flatMap((x) => (typeof x === "string" && x.trim() !== "" ? [x.trim()] : []));
  const objs = (field: string): Rec[] =>
    list(field).flatMap((x) => (isObj(x) ? [x] : (errs.push(`${field} precisa ser lista de objetos`), [])));
  const kind = req("kind");
  if (kind !== "" && !(KINDS as readonly string[]).includes(kind)) errs.push(`kind inválido: ${kind}`);
  if (o.schema_version !== PLAN_SCHEMA_VERSION)
    errs.push(`schema_version incompatível: esperado ${PLAN_SCHEMA_VERSION}`);
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    task_id: req("task_id"),
    attempt_id: req("attempt_id"),
    ticket_fingerprint: req("ticket_fingerprint"),
    base_sha: optTxt(o.base_sha),
    head_sha: optTxt(o.head_sha),
    kind: kind as PlanKind,
    problem: req("problem"),
    approach: req("approach"),
    reproduction: optTxt(o.reproduction),
    diagnosis: objs("diagnosis").map((d) => ({ ref: txt(d.ref), note: txt(d.note) })),
    rejected_alternatives: objs("rejected_alternatives").map((a) => ({ option: txt(a.option), reason: txt(a.reason) })),
    test_seams: objs("test_seams").map((s) => ({ name: txt(s.name), boundary: txt(s.boundary) })),
    steps: objs("steps").map((s) => ({
      id: txt(s.id),
      action: txt(s.action),
      files: strsOf(s.files),
      verifies: strsOf(s.verifies),
      check: txt(s.check),
    })),
    criteria: objs("criteria").map((c) => ({
      id: txt(c.id),
      covered_by: strsOf(c.covered_by),
      evidence: txt(c.evidence),
    })),
    expected_tests: strs("expected_tests"),
    risks: strs("risks"),
    deviations: strs("deviations"),
    blockers: strs("blockers"),
  };
}

function strsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.flatMap((x) => (typeof x === "string" && x.trim() !== "" ? [x.trim()] : [])) : [];
}

const isVague = (check: string): boolean => {
  const c = check.trim().toLowerCase();
  return c.length < 8 || VAGUE_CHECKS.has(c);
};

const insideRoot = (file: string): boolean => !isAbsolute(file) && !normalize(file).startsWith("..");

export function validatePlan(raw: unknown, ticket: ExecutionTicket, root: string): ValidationResult {
  if (ticket.status !== "ready")
    return { ok: false, errors: ["ticket sem critérios verificáveis: plano não se aplica"] };
  const size = JSON.stringify(raw ?? null)?.length ?? 0;
  if (size > MAX_PLAN_CHARS)
    return {
      ok: false,
      errors: [
        `plano grande demais (${size} caracteres, máximo ${MAX_PLAN_CHARS}): cite arquivos em vez de copiar código`,
      ],
    };
  const errors: string[] = [];
  const p = shape(raw, errors);
  if (!p) return { ok: false, errors };

  const stale = staleReason(p, ticket);
  if (stale === "ticket_changed") errors.push("ticket_changed: o ticket mudou desde o plano");
  if (stale === "base_changed") errors.push("base_changed: a base mudou desde o plano");
  if (p.task_id !== ticket.task_id) errors.push("task_id não bate com o ticket");
  if (p.deviations.length > 0)
    errors.push("desvio de escopo ou decisão de produto: reporte blocked com pergunta em vez de plano");
  if (p.blockers.length > 0) errors.push(`bloqueador pendente: ${p.blockers.join("; ")}`);
  if (p.kind === "bug" && !p.reproduction)
    errors.push("bug sem reprodução: informe o teste que falha antes da correção");
  if (p.kind === "feature" && p.test_seams.length === 0)
    errors.push("feature sem test_seams: informe as fronteiras observáveis");

  if (p.diagnosis.length === 0) errors.push("diagnóstico vazio");
  for (const d of p.diagnosis) {
    const m = /^(.+?):(\d+)$/.exec(d.ref);
    if (!m) {
      errors.push(`diagnóstico sem file:line: ${d.ref}`);
      continue;
    }
    const file = m[1];
    if (!insideRoot(file) || !existsSync(join(root, file)))
      errors.push(`diagnóstico aponta arquivo inexistente: ${file}`);
  }
  if (p.rejected_alternatives.length === 0 || p.rejected_alternatives.some((a) => !a.option || !a.reason))
    errors.push("falta alternativa rejeitada com motivo");

  if (p.steps.length === 0) errors.push("sem etapas");
  if (p.steps.length > MAX_STEPS) errors.push(`etapas demais (${p.steps.length}, máximo ${MAX_STEPS}): divida a issue`);
  const stepIds = new Set(p.steps.map((s) => s.id));
  if (stepIds.size !== p.steps.length) errors.push("ids de etapa repetidos");
  const acIds = ticket.acceptance.map((a) => a.id);
  for (const s of p.steps) {
    if (!s.id || !s.action) errors.push(`etapa sem id ou ação: ${s.id || "(sem id)"}`);
    if (isVague(s.check)) errors.push(`check vago na etapa ${s.id}: "${s.check}" não diz o que roda`);
    for (const v of s.verifies)
      if (!acIds.includes(v)) errors.push(`etapa ${s.id} referencia critério inexistente: ${v}`);
  }

  for (const id of acIds) {
    const c = p.criteria.find((x) => x.id === id);
    if (!c) {
      errors.push(`critério ${id} sem passo previsto`);
      continue;
    }
    if (c.covered_by.length === 0 || c.covered_by.some((s) => !stepIds.has(s)))
      errors.push(`critério ${id} sem passo válido`);
    if (!c.evidence) errors.push(`critério ${id} sem evidência prevista`);
  }
  for (const c of p.criteria) if (!acIds.includes(c.id)) errors.push(`critério desconhecido no plano: ${c.id}`);

  return errors.length > 0 ? { ok: false, errors } : { ok: true, plan: p };
}

export function renderPlanMarkdown(p: ImplementationPlan): string {
  const bullets = (xs: string[]): string => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- nenhum");
  const lines = [
    `# Plano de implementação ${p.task_id}`,
    "",
    `Tipo: ${p.kind} · Base: ${p.base_sha ?? "n/d"} · Ticket: ${p.ticket_fingerprint.slice(0, 12)}`,
    "",
    "## Problema",
    p.problem,
    "",
    "## Diagnóstico",
    ...p.diagnosis.map((d) => `- \`${d.ref}\`: ${d.note}`),
    "",
    "## Abordagem",
    p.approach,
    "",
    "## Alternativas rejeitadas",
    ...p.rejected_alternatives.map((a) => `- ${a.option}: ${a.reason}`),
    "",
    "## Reprodução",
    p.reproduction ?? "não se aplica",
    "",
    "## Etapas",
    ...p.steps.map(
      (s) => `- **${s.id}** ${s.action} (critérios ${s.verifies.join(", ") || "n/d"}; check: \`${s.check}\`)`,
    ),
    "",
    "## Critérios",
    ...p.criteria.map((c) => `- **${c.id}** coberto por ${c.covered_by.join(", ")}: ${c.evidence}`),
    "",
    "## Test seams",
    p.test_seams.length ? p.test_seams.map((s) => `- ${s.name}: ${s.boundary}`).join("\n") : "- não se aplica",
    "",
    "## Testes esperados",
    bullets(p.expected_tests),
    "",
    "## Riscos",
    bullets(p.risks),
  ];
  return lines.join("\n");
}

function writeAtomic(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

export function persistPlan(taskDir: string, p: ImplementationPlan): void {
  writeAtomic(join(taskDir, PLAN_FILE), maskSecrets(JSON.stringify(p, null, 2)));
  writeAtomic(join(taskDir, PLAN_MD_FILE), maskSecrets(renderPlanMarkdown(p)));
}

export function reusablePlan(taskDir: string, ticket: ExecutionTicket, root: string): Reuse {
  const file = join(taskDir, PLAN_FILE);
  if (!existsSync(file)) return { reuse: false, reason: "sem plano anterior" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    raw = undefined;
  }
  const r = validatePlan(raw, ticket, root);
  if (r.ok) return { reuse: true, plan: r.plan };
  renameSync(file, join(taskDir, `implementation-plan-invalid-${Date.now()}.json`));
  return { reuse: false, reason: r.errors.join("; ") };
}

export function readPhase(taskDir: string): PhaseState | null {
  try {
    const v: unknown = JSON.parse(readFileSync(join(taskDir, PHASE_FILE), "utf8"));
    return isObj(v) && (PHASES as readonly unknown[]).includes(v.phase) ? (v as unknown as PhaseState) : null;
  } catch {
    return null;
  }
}

export function writePhase(taskDir: string, state: PhaseState): void {
  writeAtomic(join(taskDir, PHASE_FILE), JSON.stringify(state, null, 2));
}

export function editBlockReason(phase: Phase | null): string | null {
  if (phase === "PLAN_READY") return null;
  return `Edição bloqueada na fase ${phase ?? "sem fase"}: registre o plano com orch_submit_plan antes de editar (fase PLAN_READY).`;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function writePreflight(taskDir: string, ticket: ExecutionTicket, root: string): void {
  const status = git(root, ["status", "--porcelain"]);
  const preflight = {
    task_id: ticket.task_id,
    attempt_id: ticket.attempt_id,
    ticket_fingerprint: ticketFingerprint(ticket),
    base_sha: ticket.origin.base_sha,
    head_sha: ticket.head_sha,
    branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty_files: status === null ? null : status.split("\n").filter(Boolean).length,
    criteria: ticket.acceptance.map((a) => a.id),
    validation_commands: ticket.validation.commands,
    cwd: root,
  };
  writeAtomic(join(taskDir, PREFLIGHT_FILE), JSON.stringify(preflight, null, 2));
}
