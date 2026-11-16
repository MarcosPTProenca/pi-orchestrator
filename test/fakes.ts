import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPort, PaneInfo, TabResult, WorkspaceResult } from "../src/herdr.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Store } from "../src/store.ts";

export type WaitFn = (target: string, until: string[], timeoutMs: number) => Promise<{ reached: string } | { timeout: true }>;

/** Herdr simulado: workspaces por projeto, tabs por tarefa e panes em memória. */
export class FakeHerdr implements HerdrPort {
  calls: { op: string; args: unknown }[] = [];
  panesList: PaneInfo[] = [];
  workspaces = new Set<string>();
  tabOf = new Map<string, string>();
  nextId = 1;
  failStart = false;
  waitImpl: WaitFn = async () => ({ timeout: true });

  private newPane(cwd: string, tabId: string): { pane_id: string; terminal_id: string } {
    const n = this.nextId++;
    const pane_id = `${tabId.split(":")[0]}:p${n}`;
    const terminal_id = `term_${pane_id}`;
    this.panesList.push({ pane_id, terminal_id, cwd, agent: null, agent_status: null });
    this.tabOf.set(pane_id, tabId);
    return { pane_id, terminal_id };
  }

  async createWorkspace(a: { cwd: string; label: string }): Promise<WorkspaceResult> {
    this.calls.push({ op: "createWorkspace", args: a });
    const workspace_id = `w${this.nextId++}`;
    this.workspaces.add(workspace_id);
    const seeded_tab_id = `${workspace_id}:t1`;
    const pane = this.newPane(a.cwd, seeded_tab_id);
    return { workspace_id, seeded_tab_id, ...pane };
  }

  async workspaceIds(): Promise<string[]> {
    return [...this.workspaces];
  }

  async createTab(a: { workspaceId: string; cwd: string; label: string; env: Record<string, string> }): Promise<TabResult> {
    this.calls.push({ op: "createTab", args: a });
    const tab_id = `${a.workspaceId}:t${this.nextId++}`;
    const pane = this.newPane(a.cwd, tab_id);
    return { tab_id, ...pane };
  }

  async closeTab(tabId: string): Promise<void> {
    this.calls.push({ op: "closeTab", args: tabId });
    const paneIds = [...this.tabOf.entries()].filter(([, t]) => t === tabId).map(([p]) => p);
    this.panesList = this.panesList.filter((p) => !paneIds.includes(p.pane_id));
    const wsId = tabId.split(":")[0];
    if (![...this.panesList].some((p) => p.pane_id.startsWith(`${wsId}:`))) this.workspaces.delete(wsId);
  }

  async startAgent(a: { name: string; paneId: string; piArgs: string[]; timeoutMs: number }): Promise<void> {
    this.calls.push({ op: "startAgent", args: a });
    if (this.failStart) throw new Error("start falhou (simulado)");
  }

  async prompt(target: string, text: string): Promise<void> {
    this.calls.push({ op: "prompt", args: { target, text } });
  }

  async waitAgent(target: string, until: string[], timeoutMs: number, signal?: AbortSignal) {
    this.calls.push({ op: "waitAgent", args: { target, until } });
    if (signal?.aborted) throw new Error("aborted");
    return this.waitImpl(target, until, timeoutMs);
  }

  async panes(): Promise<PaneInfo[]> {
    return this.panesList.map((p) => ({ ...p }));
  }

  async readRecent(_target: string, _lines: number): Promise<string> {
    this.calls.push({ op: "readRecent", args: _target });
    return this.recentText;
  }

  recentText = "";

  opsOf(op: string): { op: string; args: unknown }[] {
    return this.calls.filter((c) => c.op === op);
  }
}

export interface Harness {
  herdr: FakeHerdr;
  orch: Orchestrator;
  stateDir: string;
  project: string;
  clock: { ms: number };
}

export function makeHarness(): Harness {
  const stateDir = mkdtempSync(join(tmpdir(), "orch-state-"));
  const project = mkdtempSync(join(tmpdir(), "orch-proj-"));
  mkdirSync(join(project, ".git"));
  const herdr = new FakeHerdr();
  const clock = { ms: Date.parse("2026-11-16T12:00:00Z") };
  let counter = 0;
  const orch = new Orchestrator({
    herdr,
    store: new Store(join(stateDir, "state.json")),
    tasksDir: join(stateDir, "tasks"),
    workerExtPath: "/fake/worker-ext.ts",
    now: () => clock.ms,
    newHex: () => (++counter).toString(16).padStart(8, "a"),
  });
  return { herdr, orch, stateDir, project, clock };
}

/** Simula o worker chamando orch_report: grava report.json na pasta da tarefa. */
export function writeReport(taskDir: string, taskId: string, body: Record<string, unknown>, stamp = "t"): void {
  writeFileSync(
    join(taskDir, "report.json"),
    JSON.stringify({ task_id: taskId, question: null, artifacts: [], result: "", reported_at: stamp, ...body }),
  );
}
