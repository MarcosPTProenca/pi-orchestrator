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
