import { isActive, type TaskRecord, type TaskStatus } from "./contract.ts";
import { cacheHitRatio, mergeTurnSummaries, type TurnSummary } from "./usage.ts";

export const DEFAULT_OLD_HOURS = 24;
const RESULT_MAX = 200;
const COMPACT_RESULT_MAX = 120;
const LINKS_MAX = 5;

export function linksIn(text: string | null): string[] {
  if (!text) return [];
  const found = text.match(/https?:\/\/[^\s)\]>"']+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:]+$/, "")))].slice(0, LINKS_MAX);
}
export const COMPACT_TERMINAL_LIMIT = 10;

export function oldHoursFrom(env: string | undefined): number | undefined {
  if (env === undefined || env.trim() === "") return undefined;
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

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
  projectId?: string;
  taskId?: string;
  fullResult?: boolean;
}

interface StatusRow {
  task_id: string;
  role: string;
  status: TaskStatus;
  age: string;
  updated_at: string;
  question: string | null;
  result: string | null;
  artifacts: string[];
  verification: TaskRecord["verification"];
  model: string | null;
  deadline_at: string | null;
  tokens: number | null;
  cache_hit_ratio: number | null;
  cost_usd: number | null;
  cost_from_provider: boolean | null;
  cache_warm_cost_usd: number | null;
  turns: TurnSummary | null;
}

export interface StatusGroup {
  project_id: string;
  tasks: StatusRow[];
  turns: TurnSummary | null;
}

export function buildStatus(tasks: TaskRecord[], now: number, opts: StatusOptions): StatusGroup[] {
  const oldMs = (opts.oldHours ?? DEFAULT_OLD_HOURS) * 3_600_000;
  const visible = tasks.filter((t) => {
    if (opts.taskId !== undefined) return t.task_id === opts.taskId;
    if (opts.projectId !== undefined && t.project_id !== opts.projectId) return false;
    if (opts.all || isActive(t.status)) return true;
    if (t.status === "cancelled") return false;
    return now - Date.parse(t.updated_at) <= oldMs;
  });
  const byProject = new Map<string, StatusRow[]>();
  for (const t of visible) {
    const since = isActive(t.status) ? t.created_at : t.updated_at;
    const row: StatusRow = {
      task_id: t.task_id,
      role: t.role,
      status: t.status,
      age: ageText(now - Date.parse(since)),
      question: t.question,
      updated_at: t.updated_at,
      result:
        t.result && !opts.fullResult && t.result.length > RESULT_MAX
          ? `${t.result.slice(0, RESULT_MAX - 1)}…`
          : (t.result ?? null),
      artifacts: t.artifacts,
      verification: t.verification ?? null,
      model: t.model,
      deadline_at: t.deadline_at,
      tokens: t.usage?.totalTokens ?? null,
      cache_hit_ratio: t.usage ? cacheHitRatio(t.usage) : null,
      cost_usd: t.usage ? (t.usage.cost ?? 0) : null,
      cost_from_provider: t.usage ? t.usage.costFromProvider === true : null,
      cache_warm_cost_usd: t.usage ? (t.usage.cacheWarmCost ?? 0) : null,
      turns: t.usage?.turns ?? null,
    };
    const list = byProject.get(t.project_id) ?? [];
    list.push(row);
    byProject.set(t.project_id, list);
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project_id, rows]) => ({
      project_id,
      tasks: rows,
      turns: mergeTurnSummaries(rows.map((r) => r.turns)),
    }));
}

interface CompactTask {
  task_id: string;
  role: string;
  status: TaskStatus;
  age: string;
  question: string | null;
  result: string | null;
  artifacts: string[];
  links: string[];
  verification: TaskRecord["verification"];
  tokens: number | null;
  cost_usd: number | null;
  deadline_at: string | null;
}

export interface CompactGroup {
  project_id: string;
  counts: Record<string, number>;
  tasks: CompactTask[];
  omitted_terminal: number;
}

export function compactStatus(groups: StatusGroup[]): CompactGroup[] {
  return groups.map((g) => {
    const counts: Record<string, number> = {};
    for (const r of g.tasks) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const open = g.tasks.filter((r) => isActive(r.status) || r.status === "blocked");
    const terminal = g.tasks
      .filter((r) => !isActive(r.status) && r.status !== "blocked")
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    const shown = [...open, ...terminal.slice(0, COMPACT_TERMINAL_LIMIT)];
    return {
      project_id: g.project_id,
      counts,
      tasks: shown.map((r) => ({
        task_id: r.task_id,
        role: r.role,
        status: r.status,
        age: r.age,
        question: r.question,
        result:
          r.result && r.result.length > COMPACT_RESULT_MAX ? `${r.result.slice(0, COMPACT_RESULT_MAX - 1)}…` : r.result,
        artifacts: r.artifacts,
        links: linksIn(r.result),
        verification: r.verification,
        tokens: r.tokens,
        cost_usd: r.cost_usd,
        deadline_at: r.deadline_at,
      })),
      omitted_terminal: Math.max(0, terminal.length - COMPACT_TERMINAL_LIMIT),
    };
  });
}
