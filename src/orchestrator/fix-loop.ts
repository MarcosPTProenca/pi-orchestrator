import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Estados por tarefa/PR. Um head_sha novo sempre volta a REVIEW_PENDING: revisão antiga nunca autoriza outro commit.
type FixState = "PR_OPEN" | "REVIEW_PENDING" | "FIXING" | "REVIEW_APPROVED" | "BLOCKED" | "REVOKED";

type ReviewVerdict = "approve" | "request_changes" | "reject" | "unverified";

export type FixEvent =
  | { type: "head"; head_sha: string }
  | { type: "review"; head_sha: string; verdict: ReviewVerdict; blocking: number }
  | { type: "ci_red"; head_sha: string; checks: string[] }
  | { type: "revoke"; reason: string };

export type FixAction =
  | { kind: "none" }
  | { kind: "request_review"; head_sha: string }
  | { kind: "send_findings"; head_sha: string; key: string }
  | { kind: "send_ci_fix"; head_sha: string; key: string }
  | { kind: "approved"; head_sha: string }
  | { kind: "blocked"; reason: string };

export interface FixRecord {
  task_id: string;
  state: FixState;
  head_sha: string;
  // Ciclos de correção enviados ao worker, contados entre todos os heads.
  attempts: number;
  // Chaves task|head|falha já enviadas para o head atual; resetam quando o head muda.
  sent: string[];
  reason: string | null;
  updated_at: string;
}

export interface FixOutcome {
  record: FixRecord;
  action: FixAction;
}

const NONE: FixAction = { kind: "none" };

export function freshRecord(taskId: string, now: string): FixRecord {
  return { task_id: taskId, state: "PR_OPEN", head_sha: "", attempts: 0, sent: [], reason: null, updated_at: now };
}

export function step(rec: FixRecord, event: FixEvent, maxAttempts: number, now: string): FixOutcome {
  const keep = (): FixOutcome => ({ record: rec, action: NONE });
  const next = (patch: Partial<FixRecord>): FixRecord => ({ ...rec, ...patch, updated_at: now });

  if (rec.state === "REVOKED") return keep();
  if (event.type === "revoke") return { record: next({ state: "REVOKED", reason: event.reason }), action: NONE };
  if (rec.state === "BLOCKED") return keep();

  if (event.type === "head") {
    if (event.head_sha === rec.head_sha) return keep();
    const record = next({ state: "REVIEW_PENDING", head_sha: event.head_sha, sent: [] });
    return { record, action: { kind: "request_review", head_sha: event.head_sha } };
  }

  if (event.head_sha !== rec.head_sha) return keep();

  if (event.type === "review") {
    if (event.verdict === "approve") {
      return { record: next({ state: "REVIEW_APPROVED" }), action: { kind: "approved", head_sha: event.head_sha } };
    }
    const blocks = event.verdict === "reject" || event.blocking > 0;
    if (event.verdict === "unverified" || !blocks) return keep();
    return sendFix(rec, "review", "send_findings", maxAttempts, now);
  }

  return sendFix(rec, "ci", "send_ci_fix", maxAttempts, now);
}

function sendFix(
  rec: FixRecord,
  failure: "review" | "ci",
  kind: "send_findings" | "send_ci_fix",
  maxAttempts: number,
  now: string,
): FixOutcome {
  const key = `${rec.task_id}|${rec.head_sha}|${failure}`;
  if (rec.sent.includes(key)) return { record: rec, action: NONE };
  if (rec.attempts >= maxAttempts) {
    const reason = `limite de ${maxAttempts} ciclos atingido; última falha ${failure} em ${rec.head_sha}`;
    return {
      record: { ...rec, state: "BLOCKED", reason, updated_at: now },
      action: { kind: "blocked", reason },
    };
  }
  const record: FixRecord = {
    ...rec,
    state: "FIXING",
    attempts: rec.attempts + 1,
    sent: [...rec.sent, key],
    updated_at: now,
  };
  return { record, action: { kind, head_sha: rec.head_sha, key } };
}

export interface FixLoopOptions {
  maxAttempts: number;
  now?: () => string;
}

// Persistência em arquivo JSON único, gravado por rename atômico. Sobrevive a restart e a webhook duplicado.
export class FixLoopStore {
  private readonly now: () => string;

  constructor(
    private readonly file: string,
    private readonly opts: FixLoopOptions,
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  get(taskId: string): FixRecord | undefined {
    return this.load()[taskId];
  }

  apply(taskId: string, event: FixEvent): { action: FixAction; previous: FixRecord | null } {
    const all = this.load();
    const previous = all[taskId] ?? null;
    const at = this.now();
    const out = step(previous ?? freshRecord(taskId, at), event, this.opts.maxAttempts, at);
    all[taskId] = out.record;
    this.save(all);
    return { action: out.action, previous };
  }

  // Desfaz um apply quando o envio ao worker falha, para o próximo ciclo poder tentar de novo.
  restore(taskId: string, previous: FixRecord | null): void {
    const all = this.load();
    if (previous) all[taskId] = previous;
    else delete all[taskId];
    this.save(all);
  }

  private load(): Record<string, FixRecord> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, FixRecord>;
  }

  private save(all: Record<string, FixRecord>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
