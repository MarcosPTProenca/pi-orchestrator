/**
 * Superfícies ociosas: tarefas já terminais cuja tab (ou workspace próprio) continua aberta no Herdr.
 * Função pura (sem I/O). Classifica; quem fecha é `orch_close`, decidido pelo orquestrador (nunca automático),
 * e ambos confirmam o dono antes.
 *
 * Candidata = concluída (`done`) e já entregue ao usuário (`notified`) com tab registrada.
 * Ficam de fora as que ainda pedem atenção: ativas, bloqueadas, falhas e perdidas (podem ser
 * relançadas ou inspecionadas), canceladas (o cancelamento já fechou a superfície) e avisos
 * ainda não entregues. Fechar a tab não toca na worktree nem no relatório em disco.
 *
 * Só conta o que o Herdr confirma agora: o registro guarda ids posicionais (`w1Y:t1`) que podem
 * ser reutilizados. Vale a tab listada e o pane/terminal iguais aos do registro (mesmo dono de `orch_close`).
 */
import { isActive, type TaskRecord } from "./contract.ts";
import type { PaneInfo } from "./herdr.ts";

export interface IdleSurface {
  task_id: string;
  project_id: string;
  updated_at: string;
  projected: boolean;
}

/** Estado vivo do Herdr: ids de tab listados e panes atuais. */
export interface LiveSurfaces {
  tabIds: Set<string>;
  panes: PaneInfo[];
}

/**
 * Tarefas concluídas cuja aba e pane sumiram do Herdr: registro morto, seguro de limpar. Só vale com o Herdr respondendo
 * com abas e panes: lista vazia ou parcial (instante ruim) não pode apagar registro válido.
 */
export function deadTabTaskIds(tasks: TaskRecord[], live: LiveSurfaces): string[] {
  if (live.tabIds.size === 0 || live.panes.length === 0) return [];
  return tasks
    .filter((t) => t.status === "done" && t.tab_id !== "" && !live.tabIds.has(t.tab_id) && !live.panes.some((p) => p.pane_id === t.pane_id))
    .map((t) => t.task_id);
}

/** Verdadeiro quando a tab do registro ainda existe e o pane/terminal ainda são os da tarefa. */
export function confirmedInHerdr(t: TaskRecord, live: LiveSurfaces): boolean {
  return live.tabIds.has(t.tab_id) && live.panes.some((p) => p.pane_id === t.pane_id && p.terminal_id === t.terminal_id);
}

/** Motivo de uma concluída e entregue deixar de ser candidata porque o Herdr não confirma mais a tab/pane. */
export const STALE_SURFACE_REASON = "tab ou pane não confere mais com a tarefa no Herdr";

/** Motivo de a superfície não ser candidata a fechar, ou `null` quando é candidata. Fonte única da regra. */
export function whyNotIdle(t: TaskRecord, live: LiveSurfaces): string | null {
  if (t.status === "blocked") return "aguarda decisão";
  if (isActive(t.status)) return `ainda em andamento (${t.status})`;
  if (t.status === "cancelled") return "cancelada (a tab já foi fechada pelo cancelamento)";
  if (t.status !== "done") return `terminou como ${t.status}; pode ser relançada ou inspecionada`;
  if (!t.notified) return "resultado ainda não entregue ao usuário";
  if (!t.tab_id) return "sem tab registrada";
  if (!confirmedInHerdr(t, live)) return STALE_SURFACE_REASON;
  return null;
}

/** Recusa de `orch_close` para tarefa ativa: fechar a tab mataria um worker em andamento. */
export function closeBlocker(t: TaskRecord): string | null {
  return isActive(t.status) ? `tarefa ${t.task_id} ainda está ${t.status}; não fechei a tab. Use orch_cancel se for cancelar.` : null;
}

export function idleSurfaces(tasks: TaskRecord[], live: LiveSurfaces): IdleSurface[] {
  return tasks
    .filter((t) => whyNotIdle(t, live) === null)
    .map((t) => ({ task_id: t.task_id, project_id: t.project_id, updated_at: t.updated_at, projected: t.projected === true }))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}

/** Relatório legível: candidatas e, para cada outra tarefa, o motivo de não ser candidata. Somente leitura. */
export function idleReport(tasks: TaskRecord[], live: LiveSurfaces): { eligible: string[]; not_eligible: { task_id: string; reason: string }[] } {
  const eligible: string[] = [];
  const not_eligible: { task_id: string; reason: string }[] = [];
  for (const t of tasks) {
    const reason = whyNotIdle(t, live);
    if (reason === null) eligible.push(t.task_id);
    else not_eligible.push({ task_id: t.task_id, reason });
  }
  return { eligible: eligible.sort(), not_eligible: not_eligible.sort((a, b) => a.task_id.localeCompare(b.task_id)) };
}

/**
 * Aviso periódico sem repetição: avisa só quando surge candidata que não estava no último aviso. Sair de
 * candidata (fechada ou perdida) não avisa. Lista vazia não avisa, mas zera a chave: se a tarefa voltar, avisa de novo.
 */
export function idleAnnouncement(prevKey: string, idle: IdleSurface[]): { announce: boolean; key: string } {
  const key = idle.map((s) => s.task_id).join(",");
  if (idle.length === 0) return { announce: false, key: "" };
  const before = new Set(prevKey ? prevKey.split(",") : []);
  return { announce: idle.some((s) => !before.has(s.task_id)), key };
}

/**
 * Estado do acompanhamento periódico na sessão. `observe` diz se deve avisar; `fail` diz se a falha do Herdr
 * merece aviso (uma vez por episódio: volta a valer depois de uma conferência bem-sucedida). `reset` roda no
 * shutdown: após reload, a primeira conferência volta a avisar o que ainda estiver ocioso.
 */
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
