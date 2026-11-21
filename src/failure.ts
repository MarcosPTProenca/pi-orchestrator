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

export function suggestModel(failed: string, priority: readonly string[]): string | null {
  return priority.find((m) => m !== failed) ?? null;
}

export const MAX_AUTO_RELAUNCH = 2;

const providerOf = (model: string): string => model.split("/")[0] ?? "";

export function nextModelFor(failed: string, kind: FailureKind, priority: readonly string[]): string | null {
  if (kind === "auth") return priority.find((m) => providerOf(m) !== providerOf(failed)) ?? null;
  return suggestModel(failed, priority);
}

export function chainDepth(task: { relaunched_from?: string | null }, get: (id: string) => { relaunched_from?: string | null } | undefined): number {
  let depth = 0;
  let cur: { relaunched_from?: string | null } | undefined = task;
  while (cur?.relaunched_from && depth < 10) {
    depth++;
    cur = get(cur.relaunched_from);
  }
  return depth;
}

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
