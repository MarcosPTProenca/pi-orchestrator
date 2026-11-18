/**
 * Superfícies ociosas: tarefas já terminais cuja tab (ou workspace próprio) continua aberta no Herdr.
 * Função pura (sem I/O). Só classifica; quem fecha é `orch_close`, que confirma o dono antes.
 *
 * Candidata = concluída (`done`) e já entregue ao usuário (`notified`) com tab registrada.
 * Ficam de fora as que ainda pedem atenção: ativas, bloqueadas, falhas e perdidas (podem ser
 * relançadas ou inspecionadas), canceladas (o cancelamento já fechou a superfície) e avisos
 * ainda não entregues. Fechar a tab não toca na worktree nem no relatório em disco.
 */
import { isActive, type TaskRecord } from "./contract.ts";

export interface IdleSurface {
  task_id: string;
  project_id: string;
  updated_at: string;
  projected: boolean;
}

export function idleSurfaces(tasks: TaskRecord[]): IdleSurface[] {
  return tasks
    .filter((t) => !isActive(t.status) && t.status === "done" && t.notified && !!t.tab_id)
    .map((t) => ({ task_id: t.task_id, project_id: t.project_id, updated_at: t.updated_at, projected: t.projected === true }))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}
