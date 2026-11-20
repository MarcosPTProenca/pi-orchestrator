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

/**
 * Orientação de recuperação para falha que não é cota (#64). Diz o que é comprovado e o que não é:
 * a causa de erro do provedor não está provada, então a recuperação é relançar com cuidado, nunca presumir correção.
 */
export function failureHintFor(text: string, taskId: string): string {
  switch (classifyFailure(text)) {
    case "transient":
      return `\nErro transitório do provedor (HTTP 5xx ou timeout). A causa não está comprovada. Para retomar: confira a worktree e os commits da tentativa e relance com orch_relaunch(task_id="${taskId}") no mesmo modelo.`;
    case "auth":
      return "\nErro de credencial. Relançar sem corrigir a credencial vai falhar de novo; não troque de modelo para contornar.";
    default:
      return `\nCausa desconhecida: o relatório não basta para diagnosticar. Veja o log com orch_logs(task_id="${taskId}") e confira a worktree antes de relançar, para não repetir trabalho já feito.`;
  }
}
