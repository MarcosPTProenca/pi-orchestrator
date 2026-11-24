import { type Finding, verifySpec } from "./spec.ts";

interface AcceptanceScenario {
  id: string;
  given: string;
  when: string;
  then: string;
}

export interface TicketDraft {
  id: string;
  title: string;
  parent_fingerprint: string;
  what: string;
  requirements: string[];
  scenarios: AcceptanceScenario[];
  context: string;
  test_seams: string[];
  non_goals: string[];
  blocked_by: string[];
  validation: string[];
  dod: string[];
}

export interface Proposal {
  status: "ready" | "blocked";
  findings: Finding[];
  issues: { id: string; title: string; markdown: string }[];
}

export interface PublishResult {
  published: { id: string; ref: string }[];
  failed: { id: string; error: string } | null;
  pending: string[];
}

export type IssuePublisher = (issue: { id: string; title: string; markdown: string }) => Promise<string>;

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HORIZONTAL =
  /^(criar|create|adicionar|add|implementar|implement)\s+(a\s+|o\s+|uma?\s+)?(tabela|table|schema|migra[cç][aã]o|migration|api|endpoint|modelo|model|componente|component)\b/i;

function requirementsOf(spec: string): Set<string> {
  const lines = verifySpec(spec).body.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Requisitos");
  const ids = new Set<string>();
  if (start < 0) return ids;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const m = /^- (R\d+):/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function findCycle(tickets: TicketDraft[]): string[] | null {
  const known = new Set(tickets.map((t) => t.id));
  const deps = new Map(tickets.map((t) => [t.id, t.blocked_by.filter((d) => known.has(d))]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === "done") return null;
    if (s === "visiting") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return null;
  };
  for (const t of tickets) {
    const cycle = visit(t.id);
    if (cycle) return cycle;
  }
  return null;
}

/** Ordem de publicação: cada ticket só depois dos seus blockers. Lança se houver ciclo ou blocker ausente. */
export function publicationOrder(tickets: TicketDraft[]): TicketDraft[] {
  const done = new Set<string>();
  const out: TicketDraft[] = [];
  let pending = [...tickets];
  while (pending.length > 0) {
    const next = pending.find((t) => t.blocked_by.every((d) => done.has(d)));
    if (!next) throw new Error("ciclo ou blocker ausente: rode checkTickets antes");
    out.push(next);
    done.add(next.id);
    pending = pending.filter((t) => t !== next);
  }
  return out;
}

/** Gate determinístico: nada aqui chama LLM nem GitHub. */
export function checkTickets(spec: string, tickets: TicketDraft[]): Finding[] {
  const findings: Finding[] = [];
  const parent = verifySpec(spec);
  if (parent.status !== "approved") {
    findings.push({
      code: "spec_not_approved",
      message: `spec precisa estar approved (status atual: ${parent.status})`,
    });
  }
  const requirements = requirementsOf(spec);
  const ticketIds = new Set<string>();
  const titles = new Set<string>();
  const acIds = new Set<string>();
  const covered = new Set<string>();

  for (const t of tickets) {
    if (!SLUG.test(t.id)) findings.push({ code: "missing_id", message: `id de ticket inválido: ${t.id}` });
    if (ticketIds.has(t.id)) findings.push({ code: "duplicate_id", message: `ticket ${t.id} duplicado` });
    ticketIds.add(t.id);
    const title = t.title.trim().toLowerCase();
    if (titles.has(title)) findings.push({ code: "duplicate_title", message: `título duplicado: ${t.title}` });
    titles.add(title);
    if (t.parent_fingerprint !== parent.fingerprint) {
      findings.push({ code: "stale_parent", message: `${t.id}: parent fingerprint não bate com a spec atual` });
    }
    if (t.what.trim() === "") findings.push({ code: "empty_what", message: `${t.id}: falta o resultado demoável` });
    if (HORIZONTAL.test(t.title.trim())) {
      findings.push({
        code: "horizontal_slice",
        message: `${t.id}: título é camada técnica, não comportamento: ${t.title}`,
      });
    }
    if (t.test_seams.length === 0) findings.push({ code: "missing_test_seams", message: `${t.id}: sem test_seams` });
    if (t.validation.length === 0) findings.push({ code: "missing_validation", message: `${t.id}: sem validação` });
    if (t.scenarios.length === 0) findings.push({ code: "missing_criteria", message: `${t.id}: sem AC-IDs` });
    for (const rq of t.requirements) {
      if (!requirements.has(rq))
        findings.push({ code: "invalid_reference", message: `${t.id}: ${rq} não existe na spec` });
      else if (t.scenarios.length > 0) covered.add(rq);
    }
    for (const s of t.scenarios) {
      if (acIds.has(s.id)) findings.push({ code: "duplicate_id", message: `AC ${s.id} duplicado` });
      acIds.add(s.id);
      if ([s.given, s.when, s.then].some((v) => v.trim() === "")) {
        findings.push({ code: "scenario_incomplete", message: `${t.id}/${s.id}: falta Given, When ou Then` });
      }
    }
  }

  for (const t of tickets) {
    for (const dep of t.blocked_by) {
      if (!ticketIds.has(dep))
        findings.push({ code: "invalid_reference", message: `${t.id}: blocker ${dep} não existe` });
    }
  }
  const cycle = findCycle(tickets);
  if (cycle) findings.push({ code: "dependency_cycle", message: `ciclo de bloqueadores: ${cycle.join(" -> ")}` });

  for (const rq of requirements) {
    if (!covered.has(rq))
      findings.push({ code: "uncovered_requirement", message: `${rq} sem ticket com AC e validação` });
  }
  return findings;
}

/** Tickets cujo parent não bate mais com a spec: não atualizar automaticamente, só listar. */
export function staleTickets(tickets: TicketDraft[], spec: string): string[] {
  const fp = verifySpec(spec).fingerprint;
  return tickets.filter((t) => t.parent_fingerprint !== fp).map((t) => t.id);
}

function renderIssue(t: TicketDraft, refs: ReadonlyMap<string, string> = new Map()): string {
  const list = (items: string[]) => (items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "- nenhum");
  const blocked = t.blocked_by.map((d) => refs.get(d) ?? `ticket \`${d}\` (pendente de publicação)`);
  const acs = t.scenarios.map((s) => `- ${s.id}: Given ${s.given} / When ${s.when} / Then ${s.then}`);
  return [
    "## Parent",
    `Spec fingerprint: \`${t.parent_fingerprint}\``,
    "",
    "## What to build",
    t.what,
    "",
    "## RQ-IDs",
    list(t.requirements),
    "",
    "## AC-IDs",
    list(acs),
    "",
    "## Context / evidence",
    t.context || "nenhum",
    "",
    "## test_seams",
    list(t.test_seams),
    "",
    "## Non-goals",
    list(t.non_goals),
    "",
    "## Blocked by",
    list(blocked),
    "",
    "## Validation",
    list(t.validation),
    "",
    "## DoD",
    list(t.dod.map((d) => `[ ] ${d}`)),
  ].join("\n");
}

/** Proposta sem efeito colateral: nada é publicado aqui. */
export function proposeTickets(spec: string, tickets: TicketDraft[]): Proposal {
  const findings = checkTickets(spec, tickets);
  const issues =
    findings.length === 0
      ? publicationOrder(tickets).map((t) => ({ id: t.id, title: t.title, markdown: renderIssue(t) }))
      : [];
  return { status: findings.length === 0 ? "ready" : "blocked", findings, issues };
}

/**
 * Publica na ordem dos blockers. Exige aprovação explícita do usuário e gate limpo.
 * Em falha, para e devolve o que já foi criado, para não repetir issues.
 */
export async function publishTickets(
  spec: string,
  tickets: TicketDraft[],
  approval: "user",
  publisher: IssuePublisher,
): Promise<PublishResult> {
  if (approval !== "user") throw new Error("publicação de tickets exige aprovação do usuário");
  const findings = checkTickets(spec, tickets);
  if (findings.length > 0) throw new Error(`gate bloqueou a publicação: ${findings.map((f) => f.code).join(", ")}`);
  const refs = new Map<string, string>();
  const result: PublishResult = { published: [], failed: null, pending: [] };
  const order = publicationOrder(tickets);
  for (let i = 0; i < order.length; i++) {
    const t = order[i];
    try {
      const ref = await publisher({ id: t.id, title: t.title, markdown: renderIssue(t, refs) });
      refs.set(t.id, ref);
      result.published.push({ id: t.id, ref });
    } catch (err) {
      result.failed = { id: t.id, error: err instanceof Error ? err.message : String(err) };
      result.pending = order.slice(i + 1).map((x) => x.id);
      return result;
    }
  }
  return result;
}
