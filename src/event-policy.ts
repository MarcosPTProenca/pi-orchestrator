export type EventKind = "decision" | "conclusion" | "routine";

export const EVENT_POLICY = {
  "worker-question": "decision",
  "worker-failed": "decision",
  "worker-lost": "decision",
  "launch-failed": "decision",
  "send-failed": "decision",
  "queue-failed": "decision",
  "worker-done": "conclusion",
  "pr-merged-no-plan": "conclusion",
  "plan-completed": "conclusion",
  "pending-replay": "conclusion",
  "ci-action-sent": "routine",
  "plan-launched": "routine",
  "plan-transition": "routine",
  "idle-candidates": "routine",
  "worker-stalled": "routine",
  "herdr-check-failed": "routine",
  "orphan-worktrees": "routine",
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
