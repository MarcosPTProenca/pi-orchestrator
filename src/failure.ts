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

/** Trocas automáticas de modelo permitidas numa mesma cadeia de relançamentos. Passou disso, só avisa. */
export const MAX_AUTO_RELAUNCH = 2;

const providerOf = (model: string): string => model.split("/")[0] ?? "";

/**
 * Próximo modelo para relançar sozinho. Credencial falha no provedor: procura outro provedor, porque a
 * credencial do provedor atual não vai funcionar. Cota: qualquer outro modelo da prioridade.
 */
export function nextModelFor(failed: string, kind: FailureKind, priority: readonly string[]): string | null {
  if (kind === "auth") return priority.find((m) => providerOf(m) !== providerOf(failed)) ?? null;
  return suggestModel(failed, priority);
}

/** Quantos relançamentos já existem antes desta tarefa (segue `relaunched_from`, com limite contra ciclo). */
export function chainDepth(task: { relaunched_from?: string | null }, get: (id: string) => { relaunched_from?: string | null } | undefined): number {
  let depth = 0;
  let cur: { relaunched_from?: string | null } | undefined = task;
  while (cur?.relaunched_from && depth < 10) {
    depth++;
    cur = get(cur.relaunched_from);
  }
  return depth;
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
      return "\nErro de credencial. O orquestrador troca de provedor sozinho quando há outro disponível; se não houver, a credencial precisa ser corrigida antes de relançar.";
    default:
      return `\nCausa desconhecida: o relatório não basta para diagnosticar. Veja o log com orch_logs(task_id="${taskId}") e confira a worktree antes de relançar, para não repetir trabalho já feito.`;
  }
}
