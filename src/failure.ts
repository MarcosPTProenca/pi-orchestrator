/**
 * Classifica a causa de uma tarefa que falhou, pelo texto do relatório ou do erro. Só "quota" sugere outro modelo:
 * HTTP 500 e timeout são transitórios (tentar de novo com o mesmo modelo), e erro de credencial não se resolve trocando.
 */
export type FailureKind = "quota" | "transient" | "auth" | "other";

const QUOTA = /rate.?limit|quota|usage limit|too many requests|\b429\b|insufficient|limite de (cota|uso)/i;
const AUTH = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid.{0,12}key|credencial/i;
const TRANSIENT = /\b5\d\d\b|timed? ?out|ECONNRESET|ETIMEDOUT|network|temporar/i;

export function classifyFailure(text: string): FailureKind {
  if (QUOTA.test(text)) return "quota";
  if (AUTH.test(text)) return "auth";
  if (TRANSIENT.test(text)) return "transient";
  return "other";
}

/** Próximo modelo da ordem de prioridade que não é o que falhou. null se não há outro. */
export function suggestModel(failed: string, priority: readonly string[]): string | null {
  return priority.find((m) => m !== failed) ?? null;
}
