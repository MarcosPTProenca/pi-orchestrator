/**
 * Nome visível da sessão do orquestrador no Herdr: "orquestrador-<pasta>", no padrão aceito pelo Herdr
 * ([a-z][a-z0-9_-]{0,31}), para o painel mostrar que é o orquestrador e em qual pasta ele roda.
 */
import { basename } from "node:path";

/** Nome visível do worker (pane): worker-<projeto>-<id curto>, no padrão aceito pelo Herdr (≤32 caracteres). */
export function workerAgentName(projectPath: string, taskSuffix: string): string {
  const folder = slug(basename(projectPath), 14) || "projeto";
  return `worker-${folder}-${shortTaskId(taskSuffix)}`;
}

/** Nome da tab do worker: worker-<role>-<id curto>. Usa o mesmo id do pane, para casar os dois no painel. */
export function workerTabName(role: string, taskSuffix: string): string {
  const roleSlug = slug(role, 16) || "tarefa";
  return `worker-${roleSlug}-${shortTaskId(taskSuffix)}`;
}

function shortTaskId(taskSuffix: string): string {
  return taskSuffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "x";
}

function slug(text: string, max: number): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

export function orchestratorAgentName(cwd: string): string {
  const folder = basename(cwd)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 19)
    .replace(/-+$/g, "");
  return `orquestrador-${folder || "sessao"}`;
}
