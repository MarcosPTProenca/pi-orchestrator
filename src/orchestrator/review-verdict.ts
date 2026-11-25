import { OUTPUT_CONTRACT, type ReviewResult } from "../shared/review.ts";
import type { ReviewAssessment } from "../shared/merge-policy.ts";
import type { FixEvent } from "./fix-loop.ts";

export function reviewEvent(r: ReviewResult): FixEvent {
  return {
    type: "review",
    head_sha: r.reviewed_sha,
    verdict: r.verdict,
    blocking: r.findings.filter((f) => f.blocking).length,
  };
}

export function reviewAssessment(r: ReviewResult): ReviewAssessment | null {
  const a = r.risk_assessment;
  if (!a) return null;
  return {
    level: a.level,
    category: a.category,
    reason: a.reason,
    confidence: a.confidence,
    requires_human_judgment: r.requires_human_judgment,
    scope_drift: r.scope_drift,
  };
}

export function reviewRequestText(prUrl: string, headSha: string): string {
  return [
    `Review fresh da PR ${prUrl} no head ${headSha}.`,
    "1. Rode um subagent de review com contexto limpo (não passe a sua conversa), com ferramentas somente leitura: read, grep, find, ls.",
    `2. Diff autoritativo: git diff <base>...${headSha}. Se o diff tiver mais de 120000 caracteres, diff_truncated=true (nunca aprova).`,
    "3. Objetivo e critérios de aceite: os do seu brief (brief.md).",
    "4. Envie o JSON que o subagent devolver com orch_review_verdict (head_sha, raw, diff_truncated).",
    "O review não corrige nada: só aprova ou aponta achados.",
    OUTPUT_CONTRACT,
  ].join("\n");
}

export function integrationFixText(prUrl: string, headSha: string, reasons: string[]): string {
  return [
    `A PR ${prUrl} foi aprovada pelo review no head ${headSha}, mas o merge não pode ser pedido ainda:`,
    ...reasons.map((m) => `- ${m}`),
    "Corrija, publique o novo head e encerre o turno. O próximo review roda sozinho.",
  ].join("\n");
}

export function findingsText(prUrl: string, headSha: string, r: ReviewResult): string {
  const items = r.findings.map((f) => `- ${f.file}:${f.line} ${f.blocking ? "(bloqueante) " : ""}${f.cause}`);
  const lines = items.length > 0 ? items : [`- ${r.reason ?? "o revisor reprovou o head sem achados detalhados"}`];
  return [
    `O review reprovou o head ${headSha} da PR ${prUrl}. Corrija os achados abaixo, publique o novo head e encerre o turno.`,
    "O próximo review roda sozinho no novo head.",
    ...lines,
  ].join("\n");
}
