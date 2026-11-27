import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { TaskRecord } from "./contract.ts";

export interface WorkspaceRecord {
  workspace_id: string;
  seeded_tab_id: string | null;
}

export interface State {
  version: 1;
  tasks: Record<string, TaskRecord>;
  workspaces: Record<string, WorkspaceRecord>;
}

const ARCHIVE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled", "timeout", "lost"]);

export class Store {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  load(): State {
    if (!existsSync(this.file)) return { version: 1, tasks: {}, workspaces: {} };
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as State;
    if (parsed.version !== 1) throw new Error(`versão de estado não suportada: ${String(parsed.version)}`);
    for (const t of Object.values(parsed.tasks ?? {})) {
      const legacy = t as unknown as Record<string, unknown>;
      delete legacy.worker_started;
      delete legacy.prompt_attempts;
    }
    return { ...parsed, workspaces: parsed.workspaces ?? {} };
  }

  loadAll(): State {
    const state = this.load();
    const archiveDir = join(dirname(this.file), "archive");
    if (!existsSync(archiveDir)) return state;
    for (const file of readdirSync(archiveDir).filter((name) => /^\d{4}-\d{2}\.json$/.test(name))) {
      const archived = JSON.parse(readFileSync(join(archiveDir, file), "utf8")) as {
        tasks?: Record<string, TaskRecord>;
      };
      Object.assign(state.tasks, archived.tasks ?? {});
    }
    return state;
  }

  archiveOldTasks(now = Date.now()): number {
    const lock = this.acquireLock();
    try {
      const state = this.load();
      const cutoff = now - ARCHIVE_AGE_MS;
      const byMonth = new Map<string, Record<string, TaskRecord>>();
      for (const [id, task] of Object.entries(state.tasks)) {
        const updated = Date.parse(task.updated_at);
        if (!TERMINAL_STATUSES.has(task.status) || !Number.isFinite(updated) || updated >= cutoff) continue;
        const month = task.updated_at.slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(month)) continue;
        let monthTasks = byMonth.get(month);
        if (!monthTasks) {
          monthTasks = {};
          byMonth.set(month, monthTasks);
        }
        monthTasks[id] = task;
      }
      const count = [...byMonth.values()].reduce((sum, tasks) => sum + Object.keys(tasks).length, 0);
      if (count === 0) return 0;

      const archiveDir = join(dirname(this.file), "archive");
      for (const [month, tasks] of byMonth) {
        const path = join(archiveDir, `${month}.json`);
        const prior = existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")) as { tasks?: Record<string, TaskRecord> })
          : {};
        this.writeAtomic(path, { version: 1, month, tasks: { ...(prior.tasks ?? {}), ...tasks } });
      }
      const backup = `${this.file}.bak`;
      this.writeAtomic(backup, state);
      for (const id of Object.keys(state.tasks)) {
        const t = state.tasks[id];
        const updated = Date.parse(t.updated_at);
        if (
          TERMINAL_STATUSES.has(t.status) &&
          Number.isFinite(updated) &&
          updated < cutoff &&
          byMonth.has(t.updated_at.slice(0, 7))
        ) {
          delete state.tasks[id];
        }
      }
      this.save(state);
      return count;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  mutate<T>(fn: (state: State) => T): T {
    mkdirSync(dirname(this.file), { recursive: true });
    const lock = this.acquireLock();
    try {
      const state = this.load();
      const out = fn(state);
      this.save(state);
      return out;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  save(state: State): void {
    mkdirSync(dirname(this.file), { recursive: true });
    this.writeAtomic(this.file, state);
  }

  private acquireLock(): string {
    mkdirSync(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lock);
        return lock;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (lockAge(lock) > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
        else if (Date.now() > deadline)
          throw new Error(`estado ocupado: a trava ${lock} não liberou em ${LOCK_WAIT_MS} ms`);
        else Atomics.wait(sleep, 0, 0, 5);
      }
    }
  }

  private writeAtomic(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 2));
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

function lockAge(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return 0;
  }
}

export function defaultStateDir(): string {
  return process.env.PI_ORCH_STATE_DIR ?? join(homedir(), ".pi", "orchestrator");
}
