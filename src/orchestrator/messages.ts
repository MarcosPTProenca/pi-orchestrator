import type { WatchEvent } from "../shared/task.ts";
import { linksIn } from "./status.ts";

export function projectLabel(id: string | null | undefined): string {
  return id && id.trim() ? id.trim() : "projeto não identificado";
}

export function taskHeadline(
  t: { project_id: string; task_id: string; delegate_input?: unknown },
  prUrl: string,
  title: string,
): string {
  const objective = (t.delegate_input as { objective?: string } | null | undefined)?.objective ?? "";
  const short = objective.length > 100 ? `${objective.slice(0, 97)}...` : objective;
  const about = short ? ` Objetivo: "${short}".` : "";
  return `${title} (${projectLabel(t.project_id)}, tarefa ${t.task_id}): ${prUrl}.${about}`;
}

export function idleNoticeFor(idle: { task_id: string; project_id: string }[]): string {
  const items = idle.map((s) => `${s.task_id} (${projectLabel(s.project_id)})`).join(", ");
  return `Tarefas concluídas e entregues com aba aberta (${idle.length}): ${items}. Decida por tarefa: se nada depende da aba (PR aberta com CI vermelho, conflito de merge ou review pendente), feche com orch_close; se algo ainda precisa dela, mantenha e diga o motivo.`;
}

export type OrphanLease = { path: string; holder: string; project: string };

export function orphanReleaseNoticeFor(r: {
  released: OrphanLease[];
  kept: (OrphanLease & { note: string })[];
}): string {
  const item = (o: OrphanLease): string => `${projectLabel(o.project)}: ${o.path} (${o.holder})`;
  const parts: string[] = [];
  if (r.released.length > 0)
    parts.push(
      `Worktrees de tarefas terminais devolvidas automaticamente (${r.released.length}): ${r.released.map(item).join("; ")}.`,
    );
  if (r.kept.length > 0)
    parts.push(
      `Worktrees de tarefas terminais mantidas (${r.kept.length}): ${r.kept.map((o) => `${item(o)}: ${o.note}`).join("; ")}. Nada foi apagado.`,
    );
  return `Limpeza automática de worktrees. ${parts.join(" ")}`;
}

export function modelMessageFor(e: WatchEvent): string {
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)} [truncado; relatório completo no arquivo do worker]` : text;
  const lines = [`[evento de worker] tarefa ${e.task_id} (${projectLabel(e.project_id)}): ${e.status}`];
  if (e.result) lines.push(`Resumo do worker: ${clip(e.result, 1200)}`);
  if (e.question) lines.push(`Pergunta do worker: ${clip(e.question, 600)}`);
  if (e.artifacts.length) lines.push(`Artefatos: ${e.artifacts.join(", ")}`);
  if (e.error) lines.push(`Erro: ${clip(e.error, 400)}`);
  if (e.correction) lines.push(`Correção de aviso anterior: ${clip(e.correction, 400)}`);
  lines.push(
    "",
    "Responda ao usuário em até 5 linhas: o que aconteceu, o que ficou pronto e o que falta validar. Cite URLs de PR quando houver. Não cole o relatório do worker, e não narre o mecanismo.",
    "Se o aviso trouxer uma linha de recuperação (orch_relaunch, orch_logs ou orch_close, com o task_id), repita essa linha para o usuário: é ela que diz como seguir. Nenhuma recuperação é executada sem o pedido dele.",
    "Se houver uma linha de verificação, ela vale mais que o relatório do worker: se disser NÃO VERIFICADA, não diga que a tarefa está concluída; diga o que falta.",
  );
  return lines.join("\n");
}

// keep: pergunta operacional não é decisão do usuário; o Oracle orienta, o orquestrador valida o escopo e só então responde ao worker.
export function askMessageFor(e: WatchEvent, contract?: string): string {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} [truncado]` : text);
  const askId = e.ask_id ?? "(sem id)";
  const lines = [
    `[pergunta de worker] tarefa ${e.task_id} (${projectLabel(e.project_id)}) tem uma dúvida operacional; a tarefa segue em andamento.`,
    `Pergunta (ask_id ${askId}): ${clip(e.question ?? "", 600)}`,
  ];
  if (e.result) lines.push(`Contexto do worker: ${clip(e.result, 600)}`);
  if (e.hint) lines.push(`Aviso do diálogo: ${clip(e.hint, 400)}`);
  lines.push(
    "",
    "1. Rode o subagent `oracle-ro` (somente leitura, sem bash) com contexto limpo (não passe a sua conversa), com este contrato:",
    contract ?? "(contrato indisponível: confira só pela spec e pelo pedido)",
    `2. Chame orch_ask_verdict(task_id="${e.task_id}", ask_id="${askId}", raw=<JSON do subagent>). Uma consulta por pergunta: a segunda é recusada.`,
    `3. Só responda se o parecer for answered e a orientação couber na spec, no VISION.md ou no pedido do usuário: orch_send(task_id="${e.task_id}", ask_id="${askId}", text). Sem parecer autorizado, a resposta não chega ao worker.`,
    "4. Parecer não autorizado ou falha: não responda ao worker. Informe o usuário da pergunta e do task_id; a pergunta segue pendente até a decisão dele. Não use orch_answer: a tarefa não está bloqueada.",
  );
  return lines.join("\n");
}

export function formatEvent(e: WatchEvent): string {
  const ref = `[${e.task_id.slice(-6)}] ${projectLabel(e.project_id)}`;
  switch (e.status) {
    case "done": {
      const lines = [`${ref}: concluído. ${e.result ?? ""}`.trim()];
      if (e.artifacts.length) lines.push(`Arquivos: ${e.artifacts.join(", ")}`);
      return lines.join("\n");
    }
    case "blocked":
      return `${ref} precisa de uma decisão: ${e.question ?? "(pergunta não informada)"}`;
    case "failed":
      return `${ref}: não concluiu. ${e.error ?? ""}`.trim();
    case "timeout":
      return `${ref}: o prazo que você definiu foi atingido e o worker segue rodando. Quer que eu cancele?`;
    case "lost":
      return `${ref}: perdi o acompanhamento (${e.error ?? "motivo desconhecido"}).`;
    default:
      return `${ref}: ${e.status}`;
  }
}

const INBOX_RESULT_MAX = 300;
export const INBOX_MAX_ITEMS = 40;

export function compactEvent(ev: WatchEvent) {
  const r = ev.result;
  const long = r !== null && r.length > INBOX_RESULT_MAX;
  return {
    ...ev,
    result: r !== null && long ? `${r.slice(0, INBOX_RESULT_MAX - 1)}…` : r,
    result_truncated: long,
    links: linksIn(r),
  };
}

export function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

export function formatBrasilia(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(iso));
}
