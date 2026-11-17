/**
 * Persistência mínima do estado do orquestrador (um arquivo JSON, escrita atômica).
 */
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    return { ...parsed, workspaces: parsed.workspaces ?? {} };
  }

  save(state: State): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // Nome único por escrita: dois processos não pisam no mesmo temporário.
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.file);
  }
}

/** Diretório de estado fora dos repositórios. */
export function defaultStateDir(): string {
  return process.env.PI_ORCH_STATE_DIR ?? join(homedir(), ".pi", "orchestrator");
}
