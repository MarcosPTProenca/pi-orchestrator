/**
 * Contrato mínimo entre orquestrador e workers. Funções puras, sem I/O.
 */
import { createHash } from "node:crypto";

export const REPORT_STATUSES = ["done", "blocked", "failed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const TASK_STATUSES = [
  "planned",
  "starting",
  "running",
  "blocked",
  "done",
  "failed",
  "cancelled",
  "timeout",
  "lost",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Estados que ocupam um pane. */
const ACTIVE: readonly TaskStatus[] = ["starting", "running", "blocked"];

export function isActive(status: TaskStatus): boolean {
  return ACTIVE.includes(status);
}

/** Relatório escrito pelo worker em `report.json` via tool `orch_report`. */
export interface Report {
  task_id: string;
  status: ReportStatus;
  result: string;
  question: string | null;
  artifacts: string[];
  reported_at: string;
}

/** Registro persistido de uma tarefa. */
export interface TaskRecord {
  task_id: string;
  project_id: string;
  project_path: string;
  role: string;
  worker_id: string;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  terminal_id: string;
  status: TaskStatus;
  task_dir: string;
  brief_path: string;
  created_at: string;
  updated_at: string;
  /** Prazo explícito pedido pelo usuário (ISO UTC). null = sem prazo: o worker segue até terminar. */
  deadline_at: string | null;
  question: string | null;
  result: string | null;
  artifacts: string[];
  last_report_key: string | null;
  /** false quando há um aviso ainda não entregue ao usuário. */
  notified: boolean;
  error: string | null;
  /** Resultado da tentativa de devolver a worktree ao pool (ao cancelar ou perder a tarefa). */
  worktree_note?: string | null;
  /** Fonte da tarefa (URL de PR ou issue). Usada para não lançar duas tarefas ativas para a mesma PR. */
  source?: string | null;
  /** Branch de trabalho pedida. Usada para não lançar duas tarefas ativas na mesma branch. */
  branch?: string | null;
  /** Verificação determinística da conclusão (ver verify.ts). Separada do relatório do worker. */
  verification?: { verdict: "approved" | "rejected" | "not_applicable" | "unverified"; reason: string } | null;
  /** Uso de tokens acumulado pelo worker (usage.json, gravado no fim de cada turno). */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | null;
  /** Modelo pedido para o worker (ex.: claude-bridge/claude-haiku-5-5). null = padrão do Pi. */
  model: string | null;
  /** Modo do pedido (report, direct-pr, local-only, design). Define a regra de verificação da conclusão. */
  mode?: string;
}

export function validateReport(input: unknown, taskId: string): Report {
  if (typeof input !== "object" || input === null) {
    throw new Error("relatório inválido: não é um objeto");
  }
  const r = input as Record<string, unknown>;
  if (r.task_id !== taskId) {
    throw new Error(`relatório de outra tarefa: ${String(r.task_id)}`);
  }
  if (!(REPORT_STATUSES as readonly unknown[]).includes(r.status)) {
    throw new Error(`status de relatório inválido: ${String(r.status)}`);
  }
  const status = r.status as ReportStatus;
  const question = typeof r.question === "string" && r.question.trim() !== "" ? r.question.trim() : null;
  if (status === "blocked" && question === null) {
    throw new Error("relatório blocked exige question");
  }
  if (r.artifacts !== undefined && (!Array.isArray(r.artifacts) || !r.artifacts.every((a) => typeof a === "string"))) {
    throw new Error("artifacts deve ser uma lista de strings");
  }
  return {
    task_id: taskId,
    status,
    result: typeof r.result === "string" ? r.result : "",
    question,
    artifacts: (r.artifacts as string[] | undefined) ?? [],
    reported_at: typeof r.reported_at === "string" ? r.reported_at : "",
  };
}

/** Chave de deduplicação: hash do conteúdo bruto do arquivo de relatório. */
export function reportKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
