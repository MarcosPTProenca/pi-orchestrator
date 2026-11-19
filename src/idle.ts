/**
 * Superfícies ociosas: tarefas já terminais cuja tab (ou workspace próprio) continua aberta no Herdr.
 * Função pura (sem I/O). Só classifica; quem fecha é `orch_close`, que confirma o dono antes.
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

/** Verdadeiro quando a tab do registro ainda existe e o pane/terminal ainda são os da tarefa. */
export function confirmedInHerdr(t: TaskRecord, live: LiveSurfaces): boolean {
  return live.tabIds.has(t.tab_id) && live.panes.some((p) => p.pane_id === t.pane_id && p.terminal_id === t.terminal_id);
}

export function idleSurfaces(tasks: TaskRecord[], live: LiveSurfaces): IdleSurface[] {
  return tasks
    .filter((t) => !isActive(t.status) && t.status === "done" && t.notified && !!t.tab_id && confirmedInHerdr(t, live))
    .map((t) => ({ task_id: t.task_id, project_id: t.project_id, updated_at: t.updated_at, projected: t.projected === true }))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}

/**
 * Aviso periódico sem repetição: avisa só quando o conjunto de candidatas muda em relação ao último aviso.
 * Lista vazia não avisa, mas zera a chave: se a mesma tarefa voltar a ser candidata, avisa de novo.
 */
export function idleAnnouncement(prevKey: string, idle: IdleSurface[]): { announce: boolean; key: string } {
  const key = idle.map((s) => s.task_id).join(",");
  if (key === prevKey) return { announce: false, key };
  return { announce: idle.length > 0, key: idle.length > 0 ? key : "" };
}
