
const QUOTA_RE = /rate.?limit|quota|usage limit|too many requests|\b429\b|insufficient|exceeded|limite de/i;

export interface FallbackReport {
  task_id: string;
  status: "failed";
  result: string;
  question: null;
  artifacts: string[];
  reported_at: string;
  source: "fallback";
}

export function lastModelError(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m?.role === "assistant" && typeof m.errorMessage === "string" && m.errorMessage) return m.errorMessage;
  }
  return null;
}

export function fallbackReportFor(taskId: string, messages: unknown[], now: string, invalidReason: string | null = null): FallbackReport {
  const err = lastModelError(messages);
  const result = err && QUOTA_RE.test(err)
    ? `Cota esgotada no provedor do modelo; a tarefa não foi executada. Erro: ${err.slice(0, 300)}`
    : err
      ? `Encerrou com erro do modelo, sem orch_report. Erro: ${err.slice(0, 300)}`
      : invalidReason
        ? `Encerrou com relatório inválido, sem orch_report válido. Motivo: ${invalidReason.slice(0, 300)}`
        : "Encerrou o turno sem chamar orch_report.";
  return { task_id: taskId, status: "failed", result, question: null, artifacts: [], reported_at: now, source: "fallback" };
}
