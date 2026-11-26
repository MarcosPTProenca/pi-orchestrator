import { createHash } from "node:crypto";
import type { TurnSummary } from "./usage.ts";

export const REPORT_STATUSES = ["done", "blocked", "failed"] as const;
type ReportStatus = (typeof REPORT_STATUSES)[number];

export type TaskStatus =
  "planned" | "starting" | "running" | "blocked" | "done" | "failed" | "cancelled" | "timeout" | "lost";

const ACTIVE: readonly TaskStatus[] = ["starting", "running", "blocked"];

export function isActive(status: TaskStatus): boolean {
  return ACTIVE.includes(status);
}

export interface Report {
  task_id: string;
  status: ReportStatus;
  result: string;
  question: string | null;
  artifacts: string[];
  reported_at: string;
}

export interface TaskRecord {
  task_id: string;
  project_id: string;
  project_path: string;
  role: string;
  worker_id: string;
  workspace_id: string;
  projected?: boolean;
  owner_key?: string;
  tab_id: string;
  pane_id: string;
  terminal_id: string;
  status: TaskStatus;
  task_dir: string;
  brief_path: string;
  created_at: string;
  updated_at: string;
  deadline_at: string | null;
  question: string | null;
  result: string | null;
  artifacts: string[];
  last_report_key: string | null;
  notified: boolean;
  error: string | null;
  worktree_note?: string | null;
  reopened_from?: string | null;
  deadline_notified?: boolean;
  // keep: status pego para aviso e ainda não entregue ao LLM/tela; sobrevive a queda do processo e é reenviado no início.
  delivery_pending?: string | null;
  source?: string | null;
  branch?: string | null;
  verification?: { verdict: "approved" | "rejected" | "not_applicable" | "unverified"; reason: string } | null;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost?: number;
    costFromProvider?: boolean;
    cacheWarmCost?: number | null;
    turns?: TurnSummary | null;
  } | null;
  model: string | null;
  mode?: string;
  delegate_input?: Record<string, unknown> | null;
  released_tools?: string[];
  relaunched_from?: string | null;
}

export function validateReport(input: unknown, taskId: string): Report {
  if (typeof input !== "object" || input === null) {
    throw new Error("relatório inválido: não é um objeto");
  }
  const r = input as Record<string, unknown>;
  if (r.task_id === undefined) {
    throw new Error(`relatório sem task_id (esperado ${taskId})`);
  }
  if (r.task_id !== taskId) {
    throw new Error(`relatório de outra tarefa: ${String(r.task_id)} (esperado ${taskId})`);
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
    artifacts: r.artifacts ?? [],
    reported_at: typeof r.reported_at === "string" ? r.reported_at : "",
  };
}

export function reportKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
