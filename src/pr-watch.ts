/**
 * Acompanhamento da PR entregue por um worker. Regra do usuário: o orquestrador só fecha a aba depois do merge, e
 * quando a PR entra em conflito ele aciona o próprio worker (que já tem o contexto) para corrigir. Função pura: o
 * estado da PR entra como dado; quem busca (gh) e quem age (orch_send, closeOutcome) fica em index.ts.
 */
import type { PrState } from "./prs.ts";
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

/**
 * Aciona o conflito uma vez por cabeça de branch: enquanto o mesmo commit segue em conflito, não repete. Um push
 * novo (commit diferente) reabre o caso, porque o worker pode ter tentado corrigir e falhado.
 */
export class ConflictWatch {
  private acted = new Map<string, string>();

  /** Verdadeiro quando há conflito neste head e ainda não foi acionado para ele. */
  shouldAct(taskId: string, headOid: string, conflict: boolean): boolean {
    if (!conflict) {
      this.acted.delete(taskId);
      return false;
    }
    if (this.acted.get(taskId) === headOid) return false;
    this.acted.set(taskId, headOid);
    return true;
  }

  forget(taskId: string): void {
    this.acted.delete(taskId);
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
