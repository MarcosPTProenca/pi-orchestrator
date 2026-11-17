/**
 * Visão do orch_status: agrupada por projeto, com idade e resumo curto. Função pura (sem I/O).
 * Canceladas e terminais antigas ficam de fora por padrão; tarefa ativa nunca some.
 */
import { isActive, type TaskRecord } from "./contract.ts";

export const DEFAULT_OLD_HOURS = 24;
const RESULT_MAX = 200;

export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export interface StatusOptions {
  all?: boolean;
  oldHours?: number;
}

export interface StatusRow {
  task_id: string;
  role: string;
  status: string;
  age: string;
  question: string | null;
  result: string | null;
  artifacts: string[];
  verification: TaskRecord["verification"];
  model: string | null;
  deadline_at: string | null;
}

export interface StatusGroup {
  project_id: string;
  tasks: StatusRow[];
}

export function buildStatus(tasks: TaskRecord[], now: number, opts: StatusOptions): StatusGroup[] {
  const oldMs = (opts.oldHours ?? DEFAULT_OLD_HOURS) * 3_600_000;
  const visible = tasks.filter((t) => {
    if (opts.all || isActive(t.status)) return true;
    if (t.status === "cancelled") return false;
    return now - Date.parse(t.updated_at) <= oldMs;
  });
  const byProject = new Map<string, StatusRow[]>();
  for (const t of visible) {
    // Ativa: há quanto tempo começou. Terminal: há quanto tempo terminou.
    const since = isActive(t.status) ? t.created_at : t.updated_at;
    const row: StatusRow = {
      task_id: t.task_id,
      role: t.role,
      status: t.status,
      age: ageText(now - Date.parse(since)),
      question: t.question,
      result: t.result ? (t.result.length > RESULT_MAX ? `${t.result.slice(0, RESULT_MAX - 1)}…` : t.result) : null,
      artifacts: t.artifacts,
      verification: t.verification ?? null,
      model: t.model,
      deadline_at: t.deadline_at,
    };
    const list = byProject.get(t.project_id) ?? [];
    list.push(row);
    byProject.set(t.project_id, list);
  }
  return [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([project_id, rows]) => ({ project_id, tasks: rows }));
}
