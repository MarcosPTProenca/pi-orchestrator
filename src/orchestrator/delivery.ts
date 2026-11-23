import type { FixAction } from "./fix-loop.ts";

export type DeliveryName =
  | "plan_ready"
  | "pr_open"
  | "review_pending"
  | "changes_required"
  | "merge_eligible"
  | "merged"
  | "blocked"
  | "cancelled";

export interface DeliveryEvent {
  name: DeliveryName;
  task_id: string;
  head_sha?: string;
  pr?: string;
  reason?: string;
}

export function deliveryFromFix(action: FixAction, taskId: string): DeliveryEvent | null {
  switch (action.kind) {
    case "request_review":
      return { name: "review_pending", task_id: taskId, head_sha: action.head_sha };
    case "send_findings":
    case "send_ci_fix":
      return { name: "changes_required", task_id: taskId, head_sha: action.head_sha };
    case "approved":
      return { name: "merge_eligible", task_id: taskId, head_sha: action.head_sha };
    case "blocked":
      return { name: "blocked", task_id: taskId, reason: action.reason };
    case "none":
      return null;
  }
}
