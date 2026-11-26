import { buildIntake, MODES, type IntakeInput, type IntakePack, type Mode } from "./intake.ts";
import { maskSecrets } from "./logs.ts";
import { invalidToolRelease, isToolRelease } from "./worker-tools.ts";

export const TICKET_SCHEMA_VERSION = 1;
const POLICY_SCHEMA_VERSION = 1;
const URL_RE = /https?:\/\/[^\s)<>"']+/g;
const SCRIPT_CHECKS = ["test", "typecheck", "lint", "build"] as const;

export interface ValidationPolicy {
  schema_version: number;
  commands: string[];
  exceptions: { check: string; reason: string }[];
}

interface AcceptanceCriterion {
  id: string;
  text: string;
}

export interface TicketContext {
  task_id: string;
  attempt_id: string;
  report_path: string;
  base_sha?: string | null;
  head_sha?: string | null;
  validation: ValidationPolicy;
}

export interface ExecutionTicket {
  schema_version: number;
  task_id: string;
  attempt_id: string;
  head_sha: string | null;
  origin: { source: string | null; base_sha: string | null; references: string[] };
  project: { path: string; id: string };
  role: string;
  mode: Mode;
  model: string | null;
  objective: string;
  request: string;
  scope: string[];
  authority: { execute_plan: boolean; integrate: boolean };
  allowed_actions: string[];
  status: "ready" | "needs_clarification";
  clarification: string | null;
  acceptance: AcceptanceCriterion[];
  artifacts: { report_path: string };
  validation: ValidationPolicy;
}

interface Grant {
  execute_plan: boolean;
  integrate: boolean;
  actions: string[];
}

const GRANTS: Record<Mode, Grant> = {
  report: { execute_plan: false, integrate: false, actions: [] },
  design: { execute_plan: false, integrate: false, actions: [] },
  "direct-pr": { execute_plan: true, integrate: true, actions: ["create_branch", "commit", "push", "open_pr"] },
};

const mask = (value: string): string => maskSecrets(value);

function criteriaFor(explicit: string[] | undefined, pack: IntakePack): AcceptanceCriterion[] | null {
  if (explicit && explicit.length > 0) {
    return explicit.map((raw, i) => {
      const text = raw.trim();
      if (text === "") throw new Error(`acceptance[${i}] vazio`);
      return { id: `AC-${i + 1}`, text: mask(text) };
    });
  }
  if (pack.mode === "report") {
    return pack.acceptance.map((text, i) => ({ id: `AC-${i + 1}`, text }));
  }
  return null;
}

function referencesOf(...texts: (string | null)[]): string[] {
  const found = texts.flatMap((t) => (t ? (t.match(URL_RE) ?? []) : []));
  return [...new Set(found)];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function toExecutionTicket(
  input: IntakeInput & { acceptance?: string[]; allowed_tools?: string[] },
  ctx: TicketContext,
): ExecutionTicket {
  const pack = buildIntake(input);
  const criteria = criteriaFor(input.acceptance, pack);
  const ready = criteria !== null;
  const grant = GRANTS[pack.mode];
  const releases = input.allowed_tools ?? [];
  const badRelease = invalidToolRelease(releases);
  if (badRelease) throw new Error(badRelease);
  return deepFreeze({
    schema_version: TICKET_SCHEMA_VERSION,
    task_id: ctx.task_id,
    attempt_id: ctx.attempt_id,
    head_sha: ctx.head_sha ?? null,
    origin: {
      source: pack.source ? mask(pack.source) : null,
      base_sha: ctx.base_sha ?? null,
      references: referencesOf(pack.source, pack.spec),
    },
    project: { path: pack.project_path, id: pack.project_id },
    role: pack.role,
    mode: pack.mode,
    model: pack.model,
    objective: mask(pack.objective),
    request: mask(pack.request),
    scope: pack.constraints.map(mask),
    authority: ready
      ? { execute_plan: grant.execute_plan, integrate: grant.integrate }
      : { execute_plan: false, integrate: false },
    allowed_actions: ready ? [...grant.actions, ...releases] : [],
    status: ready ? "ready" : "needs_clarification",
    clarification: ready ? null : `sem critérios de aceite verificáveis para o modo ${pack.mode}: informe acceptance`,
    acceptance: criteria ?? [],
    artifacts: { report_path: ctx.report_path },
    validation: parseValidationPolicy(ctx.validation),
  });
}

function obj(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${field} precisa ser um objeto`);
  return value as Record<string, unknown>;
}

function text(o: Record<string, unknown>, field: string): string {
  const v = o[field];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${field} vazio ou ausente`);
  return v;
}

function optText(o: Record<string, unknown>, field: string): string | null {
  const v = o[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`${field} precisa ser texto ou null`);
  return v;
}

function strList(o: Record<string, unknown>, field: string): string[] {
  const v = o[field];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string"))
    throw new Error(`${field} precisa ser uma lista de strings`);
  return [...v];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function parseValidationPolicy(raw: unknown): ValidationPolicy {
  const o = obj(raw, "validation");
  if (o.schema_version !== POLICY_SCHEMA_VERSION) {
    throw new Error(`versão de schema incompatível: ${String(o.schema_version)} (esperado ${POLICY_SCHEMA_VERSION})`);
  }
  const commands = strList(o, "commands").map((c) => c.trim());
  if (commands.length === 0 || commands.some((c) => c === "")) throw new Error("validation sem comandos oficiais");
  const exceptions = (Array.isArray(o.exceptions) ? o.exceptions : []).map((e) => {
    const ex = obj(e, "exceção");
    const check = text(ex, "check");
    const reason = optText(ex, "reason")?.trim() ?? "";
    if (reason === "") throw new Error(`exceção sem justificativa: ${check}`);
    return { check, reason };
  });
  return { schema_version: POLICY_SCHEMA_VERSION, commands, exceptions };
}

export function validationFromScripts(scripts: Record<string, string | undefined>): ValidationPolicy {
  const commands = SCRIPT_CHECKS.filter((name) => scripts[name]).map((name) =>
    name === "test" ? "npm test" : `npm run ${name}`,
  );
  return parseValidationPolicy({ schema_version: POLICY_SCHEMA_VERSION, commands, exceptions: [] });
}

export function parseExecutionTicket(raw: unknown): ExecutionTicket {
  const o = obj(raw, "ticket");
  if (o.schema_version !== TICKET_SCHEMA_VERSION) {
    throw new Error(`versão de schema incompatível: ${String(o.schema_version)} (esperado ${TICKET_SCHEMA_VERSION})`);
  }
  const mode = text(o, "mode");
  if (!(MODES as readonly string[]).includes(mode)) throw new Error(`mode inválido: ${mode}`);
  const origin = obj(o.origin, "origin");
  const project = obj(o.project, "project");
  const authority = obj(o.authority, "authority");
  const artifacts = obj(o.artifacts, "artifacts");
  const status = text(o, "status");
  if (status !== "ready" && status !== "needs_clarification") throw new Error(`status inválido: ${status}`);
  const acceptance = (Array.isArray(o.acceptance) ? o.acceptance : []).map((a) => {
    const c = obj(a, "acceptance");
    return { id: text(c, "id"), text: text(c, "text") };
  });
  const clarification = optText(o, "clarification");
  if (status === "needs_clarification" && !clarification) throw new Error("needs_clarification exige clarification");
  if (status === "ready" && acceptance.length === 0) throw new Error("ticket pronto sem critérios de aceite");
  const grant = status === "ready" ? GRANTS[mode as Mode] : { execute_plan: false, integrate: false, actions: [] };
  const allowed = strList(o, "allowed_actions");
  if (
    !sameList(
      allowed.filter((a) => !isToolRelease(a)),
      grant.actions,
    )
  ) {
    throw new Error(`allowed_actions incompatível com o modo ${mode}`);
  }
  if (authority.execute_plan !== grant.execute_plan || authority.integrate !== grant.integrate) {
    throw new Error(`authority incompatível com o modo ${mode}`);
  }
  return deepFreeze({
    schema_version: TICKET_SCHEMA_VERSION,
    task_id: text(o, "task_id"),
    attempt_id: text(o, "attempt_id"),
    head_sha: optText(o, "head_sha"),
    origin: {
      source: optText(origin, "source"),
      base_sha: optText(origin, "base_sha"),
      references: strList(origin, "references"),
    },
    project: { path: text(project, "path"), id: text(project, "id") },
    role: text(o, "role"),
    mode: mode as Mode,
    model: optText(o, "model"),
    objective: text(o, "objective"),
    request: text(o, "request"),
    scope: strList(o, "scope"),
    authority: { execute_plan: grant.execute_plan, integrate: grant.integrate },
    allowed_actions: allowed,
    status,
    clarification,
    acceptance,
    artifacts: { report_path: text(artifacts, "report_path") },
    validation: parseValidationPolicy(o.validation),
  });
}
