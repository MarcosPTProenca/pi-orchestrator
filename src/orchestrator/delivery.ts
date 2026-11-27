import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { TaskRecord } from "../shared/contract.ts";
import type { IntegrationResult } from "../shared/merge-gate.ts";
import type { FixAction } from "./fix-loop.ts";
import {
  defaultMergePolicy,
  resolveMergePolicy,
  type MergePolicy,
  type MergePolicyStore,
  type TicketFacts,
} from "../shared/merge-policy.ts";

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

export function repoPolicyFor(store: MergePolicyStore, repo: string, taskId: string): MergePolicy | null {
  const base = store.load(repo, null) ?? store.save(defaultMergePolicy(repo));
  return resolveMergePolicy(base, taskId, null);
}

export function ticketFor(taskId: string): TicketFacts {
  return { id: taskId, state: "running", branch: null, allowed_paths: [] };
}

export function ticketFacts(t: TaskRecord): TicketFacts {
  const state: TicketFacts["state"] = t.status === "cancelled" ? "cancelled" : t.status === "done" ? "done" : "running";
  let allowed_paths: string[] = [];
  try {
    const plan: unknown = JSON.parse(readFileSync(join(t.task_dir, "implementation-plan.json"), "utf8"));
    if (
      typeof plan === "object" &&
      plan !== null &&
      "task_id" in plan &&
      plan.task_id === t.task_id &&
      "steps" in plan &&
      Array.isArray(plan.steps)
    ) {
      allowed_paths = [
        ...new Set(
          plan.steps.flatMap((step: unknown) => {
            if (typeof step !== "object" || step === null || !("files" in step) || !Array.isArray(step.files))
              return [];
            return step.files.flatMap((file: unknown) => {
              if (typeof file !== "string" || file.trim() === "" || isAbsolute(file)) return [];
              const path = normalize(file.trim());
              return path === "." || path === ".." || path.startsWith("../") ? [] : [path];
            });
          }),
        ),
      ];
    }
  } catch {}
  return { id: t.task_id, state, branch: t.branch ?? null, allowed_paths };
}

const WORKER_FIXABLE = new Set(["draft", "pr_without_issue"]);

export type IntegrationRoute =
  | { kind: "merge_requested" }
  | { kind: "ask_worker"; reasons: string[] }
  | { kind: "ask_user"; reasons: string[]; manual: boolean };

export function integrationRoute(result: IntegrationResult): IntegrationRoute {
  if (result.decision === "merge_requested" || result.decision === "already_requested")
    return { kind: "merge_requested" };
  const reasons = result.reasons.map((r) => r.message);
  const fixable = result.reasons.length > 0 && result.reasons.every((r) => WORKER_FIXABLE.has(r.code));
  if (result.decision === "blocked" && fixable) return { kind: "ask_worker", reasons };
  return { kind: "ask_user", reasons, manual: result.decision === "manual_approval" };
}
