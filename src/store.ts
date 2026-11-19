/**
 * Persistência mínima do estado do orquestrador (um arquivo JSON, escrita atômica).
 */
import { mkdirSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { TaskRecord } from "./contract.ts";

/** Workspace Herdr criado pelo orquestrador para um projeto. */
export interface WorkspaceRecord {
  workspace_id: string;
  /** Tab criada junto com o workspace. Mantida como âncora do projeto. */
  seeded_tab_id: string | null;
}

export interface State {
  version: 1;
  tasks: Record<string, TaskRecord>;
  /** Chave: project_path absoluto. */
  workspaces: Record<string, WorkspaceRecord>;
}

export class Store {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  load(): State {
    if (!existsSync(this.file)) return { version: 1, tasks: {}, workspaces: {} };
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as State;
    if (parsed.version !== 1) throw new Error(`versão de estado não suportada: ${String(parsed.version)}`);
    // Campos mortos de versões antigas saem ao carregar: a próxima gravação já não os leva.
    for (const t of Object.values(parsed.tasks ?? {})) {
      const legacy = t as unknown as Record<string, unknown>;
      delete legacy.worker_started;
      delete legacy.prompt_attempts;
    }
    return { ...parsed, workspaces: parsed.workspaces ?? {} };
  }

  /**
   * Ler, mudar e gravar num único passo, com trava entre processos. Várias sessões do orquestrador
   * (uma por projeto) gravam o mesmo state.json: sem a trava, uma gravação apagaria a outra.
   */
  mutate<T>(fn: (state: State) => T): T {
    mkdirSync(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Trava de processo morto: some depois de um tempo sem mudar. Remove e tenta de novo.
        if (lockAge(lock) > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
        else if (Date.now() > deadline) throw new Error(`estado ocupado: a trava ${lock} não liberou em ${LOCK_WAIT_MS} ms`);
        else Atomics.wait(sleep, 0, 0, 5);
      }
    }
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
    // Nome único por escrita: dois processos não pisam no mesmo temporário.
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.file);
  }
}

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

/** Idade da trava em ms; 0 se ela já sumiu (outro processo a soltou). */
function lockAge(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return 0;
  }
}

/** Diretório de estado fora dos repositórios. */
export function defaultStateDir(): string {
  return process.env.PI_ORCH_STATE_DIR ?? join(homedir(), ".pi", "orchestrator");
}
