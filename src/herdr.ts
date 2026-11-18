/**
 * Adaptador do Herdr. Usa somente a CLI oficial com saída JSON.
 * `HerdrPort` permite testes com uma implementação simulada.
 *
 * Modelo de layout (igual ao FirstMate no modo flat): um workspace por projeto,
 * uma tab por tarefa dentro dele. Não divide o pane do orquestrador.
 */
import { execFile } from "node:child_process";

export interface WorkspaceResult {
  workspace_id: string;
  /** Tab criada automaticamente pelo Herdr junto com o workspace. */
  seeded_tab_id: string;
  pane_id: string;
  terminal_id: string;
}

export interface TabResult {
  tab_id: string;
  pane_id: string;
  terminal_id: string;
}

export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  cwd: string | null;
  agent: string | null;
  agent_status: string | null;
}

export interface HerdrPort {
  createWorkspace(a: { cwd: string; label: string }): Promise<WorkspaceResult>;
  workspaceIds(): Promise<string[]>;
  createTab(a: { workspaceId: string; cwd: string; label: string; env: Record<string, string> }): Promise<TabResult>;
  closeTab(tabId: string): Promise<void>;
  /** Fecha o workspace inteiro (modo por tarefa). */
  closeWorkspace(workspaceId: string): Promise<void>;
  /** Versão do cliente Herdr (ex.: 0.9.1), ou null se não der para ler. */
  clientVersion(): Promise<string | null>;
  /** Digita o comando no pane de shell e segue sem esperar o agente aparecer (como o FirstMate). */
  runInPane(paneId: string, command: string): Promise<void>;
  /** Rótulo visível do pane. */
  renamePane(paneId: string, label: string): Promise<void>;
  startAgent(args: { name: string; paneId: string; piArgs: string[]; timeoutMs: number }): Promise<void>;
  prompt(target: string, text: string): Promise<void>;
  waitAgent(
    target: string,
    until: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ reached: string } | { timeout: true }>;
  panes(): Promise<PaneInfo[]>;
  /** Últimas linhas de texto do agente (diagnóstico). */
  readRecent(target: string, lines: number): Promise<string>;
}

export class HerdrError extends Error {
  constructor(args: string[], detail: string) {
    super(`herdr ${args.slice(0, 2).join(" ")} falhou: ${detail.trim()}`);
  }
}

/** Piso do modo por tarefa: workspaces descartáveis exigem Herdr 0.8.0 (defeito de foco nas versões anteriores). */
export const PRESENTATION_FLOOR = "0.8.0";

/** Extrai X.Y.Z da saída de `herdr --version` (ex.: "herdr 0.9.1"). */
export function parseVersion(text: string): string | null {
  const m = /\b(\d+\.\d+\.\d+)\b/.exec(text);
  return m ? m[1] : null;
}

/** true se a versão está abaixo do piso, ou se não é conhecida (desconhecida conta como abaixo). */
export function belowFloor(version: string | null, floor = PRESENTATION_FLOOR): boolean {
  if (version === null) return true;
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

type Obj = Record<string, unknown>;

function field(obj: unknown, ...path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Obj)[key];
  }
  return typeof cur === "string" && cur !== "" ? cur : undefined;
}

/** Interpreta `herdr workspace create`. */
export function parseWorkspaceCreate(json: unknown): WorkspaceResult {
  const workspace_id = field(json, "result", "workspace", "workspace_id");
  const seeded_tab_id = field(json, "result", "tab", "tab_id");
  const pane_id = field(json, "result", "root_pane", "pane_id");
  const terminal_id = field(json, "result", "root_pane", "terminal_id");
  if (!workspace_id || !seeded_tab_id || !pane_id || !terminal_id) {
    throw new Error("resposta de workspace create sem workspace/tab/root_pane");
  }
  return { workspace_id, seeded_tab_id, pane_id, terminal_id };
}

/** Interpreta `herdr tab create`. */
export function parseTabCreate(json: unknown): TabResult {
  const tab_id = field(json, "result", "tab", "tab_id");
  const pane_id = field(json, "result", "root_pane", "pane_id");
  const terminal_id = field(json, "result", "root_pane", "terminal_id");
  if (!tab_id || !pane_id || !terminal_id) throw new Error("resposta de tab create sem tab/root_pane");
  return { tab_id, pane_id, terminal_id };
}

/** Interpreta `herdr workspace list`. */
export function parseWorkspaceIds(json: unknown): string[] {
  const list = (json as { result?: { workspaces?: unknown[] } })?.result?.workspaces;
  if (!Array.isArray(list)) throw new Error("resposta de workspace list sem workspaces");
  return list.map((w) => String((w as Obj).workspace_id));
}

/** Interpreta `herdr api snapshot` e devolve os panes. */
export function parsePanes(json: unknown): PaneInfo[] {
  const panes = (json as { result?: { snapshot?: { panes?: unknown[] } } })?.result?.snapshot?.panes;
  if (!Array.isArray(panes)) throw new Error("resposta de api snapshot sem panes");
  return panes.map((p) => {
    const x = p as Obj;
    return {
      pane_id: String(x.pane_id),
      terminal_id: String(x.terminal_id),
      cwd: typeof x.cwd === "string" ? x.cwd : null,
      agent: typeof x.agent === "string" ? x.agent : null,
      agent_status: typeof x.agent_status === "string" ? x.agent_status : null,
    };
  });
}

export class HerdrCli implements HerdrPort {
  private readonly bin: string;

  constructor(bin?: string) {
    this.bin = bin ?? process.env.HERDR_BIN ?? "herdr";
  }

  private run(args: string[], timeoutMs = 30_000, signal?: AbortSignal): Promise<{ stdout: string; error?: string }> {
    return new Promise((resolve) => {
      execFile(this.bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal }, (err, stdout, stderr) => {
        if (err) {
          resolve({ stdout, error: stderr || stdout || err.message });
          return;
        }
        resolve({ stdout });
      });
    });
  }

  private async runOk(args: string[], timeoutMs?: number): Promise<string> {
    const r = await this.run(args, timeoutMs);
    if (r.error !== undefined) throw new HerdrError(args, r.error);
    return r.stdout;
  }

  async createWorkspace(a: { cwd: string; label: string }): Promise<WorkspaceResult> {
    const out = await this.runOk(["workspace", "create", "--cwd", a.cwd, "--label", a.label, "--no-focus"]);
    return parseWorkspaceCreate(JSON.parse(out));
  }

  async workspaceIds(): Promise<string[]> {
    return parseWorkspaceIds(JSON.parse(await this.runOk(["workspace", "list"])));
  }

  async createTab(a: { workspaceId: string; cwd: string; label: string; env: Record<string, string> }): Promise<TabResult> {
    const args = ["tab", "create", "--workspace", a.workspaceId, "--cwd", a.cwd, "--label", a.label, "--no-focus"];
    for (const [k, v] of Object.entries(a.env)) args.push("--env", `${k}=${v}`);
    return parseTabCreate(JSON.parse(await this.runOk(args)));
  }

  async closeTab(tabId: string): Promise<void> {
    await this.runOk(["tab", "close", tabId]);
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.runOk(["workspace", "close", workspaceId]);
  }

  async clientVersion(): Promise<string | null> {
    return parseVersion(await this.runOk(["--version"]));
  }

  async runInPane(paneId: string, command: string): Promise<void> {
    await this.runOk(["pane", "run", paneId, command]);
  }

  async renamePane(paneId: string, label: string): Promise<void> {
    await this.runOk(["pane", "rename", paneId, label]);
  }

  async startAgent(a: { name: string; paneId: string; piArgs: string[]; timeoutMs: number }): Promise<void> {
    const args = ["agent", "start", a.name, "--kind", "pi", "--pane", a.paneId, "--timeout", String(a.timeoutMs), "--", ...a.piArgs];
    await this.runOk(args, a.timeoutMs + 15_000);
  }

  async prompt(target: string, text: string): Promise<void> {
    await this.runOk(["agent", "prompt", target, text]);
  }

  async waitAgent(
    target: string,
    until: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ reached: string } | { timeout: true }> {
    const args = ["agent", "wait", target];
    for (const u of until) args.push("--until", u);
    args.push("--timeout", String(timeoutMs));
    const r = await this.run(args, timeoutMs + 15_000, signal);
    if (r.error === undefined) {
      return { reached: extractStatus(r.stdout) ?? until[0] };
    }
    if (/timed? ?out/i.test(r.error)) return { timeout: true };
    throw new HerdrError(args, r.error);
  }

  async readRecent(target: string, lines: number): Promise<string> {
    return this.runOk(["agent", "read", target, "--source", "recent", "--lines", String(lines), "--format", "text"]);
  }

  async panes(): Promise<PaneInfo[]> {
    return parsePanes(JSON.parse(await this.runOk(["api", "snapshot"])));
  }
}

function extractStatus(stdout: string): string | undefined {
  try {
    const json = JSON.parse(stdout) as Obj;
    const result = (json.result ?? {}) as Obj;
    const agent = (result.agent ?? result) as Obj;
    return typeof agent.agent_status === "string" ? agent.agent_status : undefined;
  } catch {
    return undefined;
  }
}
