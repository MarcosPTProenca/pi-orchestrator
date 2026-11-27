export type EventKind = "decision" | "conclusion" | "routine";

export const EVENT_POLICY = {
  "worker-question": "decision",
  "worker-failed": "decision",
  "worker-lost": "decision",
  "launch-failed": "decision",
  // keep: falha no avanço ou reconciliação de plano; o aviso sai uma vez por episódio (PlanFailureWatch), não a cada ciclo.
  "plan-failed": "decision",
  "send-failed": "decision",
  "fix-blocked": "decision",
  "review-approved": "decision",
  "queue-failed": "decision",
  "worker-done": "conclusion",
  "pr-merged-no-plan": "conclusion",
  "plan-completed": "conclusion",
  "pending-replay": "conclusion",
  "ci-action-sent": "routine",
  // keep: decision aqui tem orch_send/orch_close/orch_cancel/orch_release reais; herdr-check-failed e readonly-session não têm ação possível.
  "plan-launched": "decision",
  "plan-transition": "decision",
  // keep: revisão de escopo pede ao LLM o subagent oracle; fora do escopo bloqueia o item e pede decisão do usuário.
  "scope-review": "decision",
  "scope-blocked": "decision",
  "idle-candidates": "decision",
  "worker-stalled": "decision",
  "herdr-check-failed": "routine",
  "orphan-worktrees": "decision",
  "readonly-session": "routine",
} as const satisfies Record<string, EventKind>;

export function wakesLlm(kind: EventKind): boolean {
  return kind !== "routine";
}

export function statusKind(status: string): EventKind {
  return status === "done" ? "conclusion" : "decision";
}

export const UI_ENTRY = "orch-ui";

export type EventMessage = { customType: string; content: string; display: boolean; details?: unknown };
export type EventSink = {
  sendMessage(msg: EventMessage, opts: { triggerTurn: boolean }): void;
  appendEntry(customType: string, data: { content: string }): void;
};

// keep: rotineiro vai só para a tela (appendEntry, fora do contexto da LLM); decisão e conclusão entram no contexto.
export function emitEvent(sink: EventSink, kind: EventKind, msg: EventMessage): void {
  if (kind === "routine") {
    sink.appendEntry(UI_ENTRY, { content: msg.content });
    return;
  }
  sink.sendMessage(msg, { triggerTurn: wakesLlm(kind) });
}
