import type { VisionDoc } from "../shared/intake.ts";
import { VISION_FILE } from "../shared/intake.ts";
import type { ScopeReview, ScopeVerdict } from "./plans.ts";

type Verification = { verdict: "approved" | "rejected" | "not_applicable" | "unverified"; reason: string } | null;

export type ScopeStep =
  { action: "request" } | { action: "wait" } | { action: "advance" } | { action: "block"; reason: string };

// keep: o worker só entra na revisão depois de verificação aprovada ou não aplicável; rejeitada ou não conferida segue como antes (sem revisão nova).
export function scopeStep(scope: ScopeReview | null, verification: Verification | undefined): ScopeStep {
  if (scope) {
    if (scope.verdict === "pending") return { action: "wait" };
    if (scope.verdict === "aligned") return { action: "advance" };
    if (scope.verdict === "out_of_scope")
      return { action: "block", reason: `fora do escopo: ${scope.reason ?? "sem razão"}` };
    return { action: "block", reason: `revisão de escopo não conseguiu conferir: ${scope.reason ?? "sem razão"}` };
  }
  if (verification === undefined || verification === null) return { action: "wait" };
  if (verification.verdict === "approved" || verification.verdict === "not_applicable") return { action: "request" };
  return { action: "advance" };
}

const VERDICTS: readonly ScopeVerdict[] = ["aligned", "out_of_scope", "unverified"];
const MAX_REASON_CHARS = 500;

export function parseScopeVerdict(raw: string): { verdict: ScopeVerdict; reason: string } {
  const body = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('veredito precisa ser JSON: {"verdict":"aligned|out_of_scope|unverified","reason":"..."}');
  }
  const o = parsed as { verdict?: unknown; reason?: unknown };
  if (typeof o.verdict !== "string" || !(VERDICTS as readonly string[]).includes(o.verdict))
    throw new Error(`verdict inválido: use ${VERDICTS.join(", ")}`);
  if (typeof o.reason !== "string" || o.reason.trim() === "") throw new Error("reason obrigatório");
  return { verdict: o.verdict as ScopeVerdict, reason: o.reason.trim().slice(0, MAX_REASON_CHARS) };
}

function visionText(vision: VisionDoc): string {
  switch (vision.status) {
    case "present":
      return vision.content;
    case "missing":
      return `(o projeto não tem ${VISION_FILE}; confira só contra a spec e o pedido)`;
    case "unreadable":
      return `(${VISION_FILE} existe mas não pôde ser lido: ${vision.reason}; confira só contra a spec e o pedido)`;
  }
}

export interface ScopeContext {
  taskId: string;
  planId: string;
  itemId: string;
  itemTitle: string;
  projectLabel: string;
  projectPath: string;
  request: string;
  objective: string;
  source: string | null;
  branch: string | null;
  artifacts: string[];
  vision: VisionDoc;
}

// keep: o orquestrador avalia a entrega ele mesmo (#256); o parecer volta por orch_scope_verdict e a verificação determinística segue como gate.
export function scopeReviewText(c: ScopeContext): string {
  return [
    `Revisão de escopo do item ${c.planId}/${c.itemId} (${c.itemTitle}), tarefa ${c.taskId} (${c.projectLabel}).`,
    "O worker reportou done e a verificação passou. O plano não avança antes do seu parecer.",
    "1. Avalie você mesmo, sem subagent, com o contrato abaixo. Seu parecer complementa a verificação determinística e não a substitui.",
    "2. Contrato:",
    `   - Repositório: ${c.projectPath}. Leia o resultado com git (git log, git diff) a partir da branch ou dos artefatos abaixo.`,
    `   - Pedido: ${c.request}`,
    `   - Objetivo: ${c.objective}`,
    `   - Spec ou ticket de origem: ${c.source ?? "(nenhuma informada)"}`,
    `   - Branch: ${c.branch ?? "(não informada)"}. Artefatos: ${c.artifacts.join(" ") || "(nenhum)"}`,
    `   - Visão do projeto (${VISION_FILE}):`,
    visionText(c.vision),
    "   - Pergunte: o resultado está alinhado com a spec? Está no caminho da visão? O que foi feito além ou aquém do pedido?",
    '3. Responda só em JSON: {"verdict":"aligned"|"out_of_scope"|"unverified","reason":"uma frase"}. "unverified" quando não conseguir conferir.',
    `4. Chame orch_scope_verdict(task_id="${c.taskId}", raw=<seu JSON>). Se a ferramenta recusar o JSON, corrija e chame de novo.`,
    "Não corrija nada: divergência vai ao usuário como pergunta, e ele decide.",
  ].join("\n");
}

const warnedProjects = new Set<string>();

// keep: aviso de VISION.md ausente sai uma vez por projeto e por processo; depois disso o fluxo segue sem repetir.
export function missingVisionNotice(projectPath: string, vision: VisionDoc): string | null {
  if (vision.status !== "missing" || warnedProjects.has(projectPath)) return null;
  warnedProjects.add(projectPath);
  return `O projeto ${projectPath} não tem ${VISION_FILE} na raiz. A revisão de escopo vai conferir só contra a spec. Para ancorar o escopo numa visão, crie o ${VISION_FILE} com a skill \`vision\`.`;
}

export function resetVisionNotices(): void {
  warnedProjects.clear();
}
