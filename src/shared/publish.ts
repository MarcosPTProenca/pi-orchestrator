import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PublishAction = "commit" | "push" | "open_pr";

export interface PublishState {
  task_id: string;
  attempt_id: string;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  pushed_sha: string | null;
  pr_url: string | null;
}

export interface GitNow {
  branch: string | null;
  head_sha: string | null;
}

const PUBLISH_FILE = "publish-state.json";
const SEP = "(?:^|[;&|(]\\s*)";
const PATTERNS: { action: PublishAction; re: RegExp }[] = [
  { action: "commit", re: new RegExp(`${SEP}git\\s+(?:-C\\s+\\S+\\s+)?commit\\b`, "m") },
  { action: "push", re: new RegExp(`${SEP}git\\s+(?:-C\\s+\\S+\\s+)?push\\b`, "m") },
  { action: "open_pr", re: new RegExp(`${SEP}gh(?:-axi)?\\s+pr\\s+create\\b`, "m") },
];

export function publishActionsIn(command: string): PublishAction[] {
  return PATTERNS.filter((p) => p.re.test(command)).map((p) => p.action);
}

export function publishBlockReason(
  command: string,
  allowed: string[],
  state: PublishState | null,
  now: () => GitNow,
): string | null {
  for (const action of publishActionsIn(command)) {
    if (!allowed.includes(action)) {
      return `ação ${action} não permitida pelo ticket (allowed_actions: ${allowed.join(", ") || "nenhuma"})`;
    }
    if (action === "open_pr" && state?.pr_url) {
      return `PR já registrada (${state.pr_url}): atualize a existente em vez de criar outra`;
    }
    if (action === "push" && state) {
      const git = now();
      if (state.branch && git.branch && git.branch !== state.branch) {
        return `branch atual (${git.branch}) difere da branch do attempt (${state.branch})`;
      }
      if (state.pushed_sha && state.pushed_sha === git.head_sha) {
        return `HEAD ${git.head_sha} já publicado: não repita o push`;
      }
    }
  }
  return null;
}

export function nextPublishState(
  prev: PublishState | null,
  ids: { task_id: string; attempt_id: string; base_sha: string | null },
  facts: GitNow & { pushed_sha: string | null },
  prUrl?: string | null,
): PublishState {
  const same = prev?.task_id === ids.task_id ? prev : null;
  return {
    task_id: ids.task_id,
    attempt_id: ids.attempt_id,
    branch: facts.branch ?? same?.branch ?? null,
    base_sha: ids.base_sha,
    head_sha: facts.head_sha,
    pushed_sha: facts.pushed_sha ?? same?.pushed_sha ?? null,
    pr_url: prUrl ?? same?.pr_url ?? null,
  };
}

export function reconcilePublish(state: PublishState, lookup: (branch: string) => string | null): PublishState {
  if (state.pr_url || !state.branch || !state.pushed_sha) return state;
  const url = lookup(state.branch);
  return url ? { ...state, pr_url: url } : state;
}

export function readPublishState(taskDir: string): PublishState | null {
  const file = join(taskDir, PUBLISH_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as PublishState;
}

export function writePublishState(taskDir: string, state: PublishState): void {
  const file = join(taskDir, PUBLISH_FILE);
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}
