/**
 * Acompanhamento da PR entregue por um worker. Regra do usuário: o orquestrador só fecha a aba depois do merge, e
 * quando a PR entra em conflito ele aciona o próprio worker (que já tem o contexto) para corrigir. Função pura: o
 * estado da PR entra como dado; quem busca (gh) e quem age (orch_send, closeOutcome) fica em index.ts.
 */
import { FAILING, type PrState } from "./prs.ts";
import type { TaskRecord } from "./contract.ts";

export type PrVerdict = "merged" | "conflict" | "open" | "pending";

/** Merge tem precedência sobre conflito: PR fechada não precisa de correção. */
export function prVerdict(s: PrState): PrVerdict {
  if (s.state === "MERGED") return "merged";
  if (s.mergeable === "CONFLICTING" || s.mergeStateStatus === "DIRTY") return "conflict";
  if (s.mergeable === "UNKNOWN") return "pending";
  return "open";
}

/**
 * Tarefa que o acompanhamento de PR pode tocar: concluída, com resultado já entregue ao usuário e aba registrada.
 * Sem `notified`, fechar a aba ou enviar mensagem ao worker marcaria como entregue um relatório que o usuário não viu.
 */
export function isPrWatched(t: Pick<TaskRecord, "status" | "notified" | "source" | "tab_id">): boolean {
  return t.status === "done" && t.notified && !!t.source && !!t.tab_id;
}

export type PrAction = "conflict" | "ci";

/** Nomes dos checks que falharam (conclusão de falha, não pendente nem sucesso). Vazio quando nada falhou. */
export function failingChecks(s: PrState): string[] {
  return [...new Set(s.checks.filter((c) => c.conclusion !== null && FAILING.has(c.conclusion.toUpperCase())).map((c) => c.name))];
}

/**
 * Aciona cada tipo de problema (conflito ou CI) uma vez por cabeça de branch. Um push novo (commit diferente) reabre o
 * caso, porque o worker pode ter tentado corrigir e falhado. Tipos são independentes: sair de um não zera o outro.
 */
export class PrActionWatch {
  private acted = new Map<string, string>();

  /** Verdadeiro quando o problema está ativo neste head e ainda não foi acionado para ele. Não marca nada: use `markActed`. */
  shouldAct(taskId: string, headOid: string, active: boolean, kind: PrAction): boolean {
    const key = `${taskId}|${kind}`;
    if (!active) {
      this.acted.delete(key);
      return false;
    }
    return this.acted.get(key) !== headOid;
  }

  /** Marca o head como acionado. Chamar só depois do envio bem-sucedido, para uma falha poder ser tentada de novo. */
  markActed(taskId: string, headOid: string, kind: PrAction): void {
    this.acted.set(`${taskId}|${kind}`, headOid);
  }

  forget(taskId: string): void {
    for (const kind of ["conflict", "ci"] as const) this.acted.delete(`${taskId}|${kind}`);
  }
}

/** Texto enviado ao próprio worker para corrigir o conflito. Pede o que se espera de uma entrega: checks e push. */
export function conflictInstruction(prUrl: string): string {
  return [
    `A PR ${prUrl} está com conflito de merge com a base. Atualize a branch com a base (git merge origin/<base>),`,
    "resolva os conflitos preservando a intenção de cada lado, rode os mesmos checks do CI localmente e envie o push",
    "para a mesma branch. Não reescreva histórico nem faça force-push. Se o conflito exigir decisão de produto, pare e diga",
    "quais arquivos conflitam e por quê.",
  ].join(" ");
}

/** Texto enviado ao próprio worker quando o CI da PR falha: nomeia os checks e pede a mesma disciplina de entrega. */
export function ciInstruction(prUrl: string, failing: string[]): string {
  return [
    `A PR ${prUrl} tem checks do CI falhando: ${failing.join(", ")}.`,
    "Leia o log da falha (gh run view <id> --log-failed), corrija a causa na mesma branch, rode localmente os checks que",
    "falharam e envie o push. Não reescreva histórico nem faça force-push. Se a falha for de infraestrutura externa,",
    "não relacionada à mudança, diga qual é a evidência e pare.",
  ].join(" ");
}
