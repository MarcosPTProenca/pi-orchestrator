import { isActive, type TaskRecord } from "../shared/contract.ts";
import type { PaneInfo } from "../shared/herdr.ts";
import { prUrlOf } from "./pr-watch.ts";

export interface IdleSurface {
  task_id: string;
  project_id: string;
  updated_at: string;
  projected: boolean;
}

export interface LiveSurfaces {
  tabIds: Set<string>;
  panes: PaneInfo[];
}

export function deadTabTaskIds(tasks: TaskRecord[], live: LiveSurfaces): string[] {
  if (live.tabIds.size === 0 || live.panes.length === 0) return [];
  return tasks
    .filter(
      (t) =>
        t.status === "done" &&
        t.tab_id !== "" &&
        !live.tabIds.has(t.tab_id) &&
        !live.panes.some((p) => p.pane_id === t.pane_id),
    )
    .map((t) => t.task_id);
}

function confirmedInHerdr(t: TaskRecord, live: LiveSurfaces): boolean {
  return (
    // keep: ids de tab são posicionais e podem ser reutilizados; sem conferir pane e terminal, a aba de outra tarefa seria tomada.
    live.tabIds.has(t.tab_id) && live.panes.some((p) => p.pane_id === t.pane_id && p.terminal_id === t.terminal_id)
  );
}

const STALE_SURFACE_REASON = "tab ou pane não confere mais com a tarefa no Herdr";

export function whyNotIdle(t: TaskRecord, live: LiveSurfaces): string | null {
  if (t.status === "blocked") return "aguarda decisão";
  if (isActive(t.status)) return `ainda em andamento (${t.status})`;
  if (t.status === "cancelled") return "cancelada (a tab já foi fechada pelo cancelamento)";
  if (t.status !== "done") return `terminou como ${t.status}; pode ser relançada ou inspecionada`;
  if (!t.notified) return "resultado ainda não entregue ao usuário";
  if (!t.tab_id) return "sem tab registrada";
  if (!confirmedInHerdr(t, live)) return STALE_SURFACE_REASON;
  if (prUrlOf(t) !== null) return "aguarda merge da PR; o orquestrador fecha a aba quando ela for mergeada";
  return null;
}

export function closeBlocker(t: TaskRecord): string | null {
  return isActive(t.status)
    ? `tarefa ${t.task_id} ainda está ${t.status}; não fechei a tab. Use orch_cancel se for cancelar.`
    : null;
}

export function idleSurfaces(tasks: TaskRecord[], live: LiveSurfaces): IdleSurface[] {
  return tasks
    .filter((t) => whyNotIdle(t, live) === null)
    .map((t) => ({
      task_id: t.task_id,
      project_id: t.project_id,
      updated_at: t.updated_at,
      projected: t.projected === true,
    }))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}

export function idleReport(
  tasks: TaskRecord[],
  live: LiveSurfaces,
): { eligible: string[]; not_eligible: { task_id: string; reason: string }[] } {
  const eligible: string[] = [];
  const not_eligible: { task_id: string; reason: string }[] = [];
  for (const t of tasks) {
    const reason = whyNotIdle(t, live);
    if (reason === null) eligible.push(t.task_id);
    else not_eligible.push({ task_id: t.task_id, reason });
  }
  return { eligible: eligible.sort(), not_eligible: not_eligible.sort((a, b) => a.task_id.localeCompare(b.task_id)) };
}

export function idleAnnouncement(prevKey: string, idle: IdleSurface[]): { announce: boolean; key: string } {
  const key = idle.map((s) => s.task_id).join(",");
  if (idle.length === 0) return { announce: false, key: "" };
  const before = new Set(prevKey ? prevKey.split(",") : []);
  return { announce: idle.some((s) => !before.has(s.task_id)), key };
}

export class IdleWatch {
  private key = "";
  private failing = false;

  observe(idle: IdleSurface[]): boolean {
    this.failing = false;
    const { announce, key } = idleAnnouncement(this.key, idle);
    this.key = key;
    return announce;
  }

  fail(): boolean {
    if (this.failing) return false;
    this.failing = true;
    return true;
  }

  reset(): void {
    this.key = "";
    this.failing = false;
  }
}
