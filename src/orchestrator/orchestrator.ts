import { workerSessionFile } from "../shared/session-file.ts";
import { resolveModel } from "../shared/models.ts";
import { workerAgentName, workerTabName } from "../shared/label.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { toExecutionTicket, validationFromScripts, type ExecutionTicket } from "../shared/execution-ticket.ts";
import { TICKET_FILE } from "../shared/plan.ts";
import { latestAsk, oracleVerdictFor } from "../shared/ask.ts";
import {
  DIALOGUE_BUDGET_DEFAULT,
  judgeAsk,
  newDialogue,
  recordAsk,
  redirectHint,
  resolveDialogueBudget,
  stopSummary,
} from "../shared/dialogue.ts";
import { appendHistory, readHistory, type HistoryInput, type HistoryPage } from "../shared/history.ts";
import { invalidToolRelease, workerToolArgs, workerToolSet } from "../shared/worker-tools.ts";
import { clampLines, logError, maskSecrets } from "../shared/logs.ts";
import { summarizeTurns, type TurnRecord } from "../shared/usage.ts";
import { classifyFailure } from "../policy/failure.ts";
import { RELAUNCH_MARK, relaunchContext, relaunchNotice } from "./relaunch-context.ts";
import { isActive, reportKey, validateReport, type TaskRecord, type TaskStatus } from "../shared/contract.ts";
import type { Report } from "../shared/contract.ts";
import { belowFloor, PRESENTATION_FLOOR, type HerdrPort, type PaneInfo, type TabResult } from "../shared/herdr.ts";
import type { Store } from "../shared/store.ts";

export interface OrchDeps {
  releaseWorktree?: (task: TaskRecord) => string;
  herdr: HerdrPort;
  presentationSpaces?: boolean;
  store: Store;
  tasksDir: string;
  workerExtPath: string;
  now: () => number;
  newHex: () => string;
  availableModels: () => string[];
  dryRun: boolean;
  enrichSource?: (input: DelegateInput) => Promise<DelegateInput>;
  chooseModel?: (requested: string | undefined) => Promise<{ model: string | undefined; reason: string }>;
  hookUrl?: string;
  hookToken?: string;
  onTerminal?: (taskId: string) => void;
}

export { MODES } from "../shared/intake.ts";
import { buildIntake, renderBrief } from "../shared/intake.ts";
import { launchMessage } from "../shared/launch.ts";
import type { DelegateInput, WatchEvent } from "../shared/task.ts";
export type { DelegateInput, WatchEvent } from "../shared/task.ts";

const OP_LOCK_WAIT_MS = 5_000;
// keep: pane ocioso sem orch_report além deste tempo é falha (#227); um report posterior reabre a tarefa.
const IDLE_NO_REPORT_MS = 10 * 60_000;
const OP_LOCK_STALE_MS = 30_000;

function proximoPasso(status: TaskStatus): string {
  switch (status) {
    case "starting":
      return "aguarde o worker iniciar (orch_status) e use orch_send depois";
    case "running":
      return "use orch_send para mandar instrução ao worker";
    case "done":
      return "use orch_send para continuar a mesma tarefa, ou orch_delegate para uma tarefa nova";
    case "failed":
      return "use orch_relaunch para tentar de novo, ou orch_delegate para uma tarefa nova";
    default:
      return "use orch_delegate para uma tarefa nova";
  }
}

function ticketForDelegate(
  input: DelegateInput,
  model: string | null,
  ids: { taskId: string; reportPath: string },
): ExecutionTicket | null {
  if (!input.acceptance || input.acceptance.length === 0) return null;
  const head = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: input.project_path, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  })();
  const pkg = join(input.project_path, "package.json");
  const manifest = existsSync(pkg)
    ? (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> })
    : {};
  return toExecutionTicket(
    { ...input, model: model ?? undefined },
    {
      task_id: ids.taskId,
      attempt_id: `${ids.taskId}-a1`,
      report_path: ids.reportPath,
      base_sha: head,
      head_sha: null,
      validation: validationFromScripts(manifest.scripts ?? {}),
    },
  );
}

function sameWork(a: DelegateInput, b: DelegateInput): string | null {
  if (a.project_path !== b.project_path) return null;
  const sa = a.source?.trim();
  if (sa && sa === b.source?.trim()) return `PR (${sa})`;
  const ba = a.branch?.trim();
  if (ba && ba === b.branch?.trim()) return `branch ${ba}`;
  return null;
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
function isFallbackRaw(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { source?: unknown }).source === "fallback";
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Orchestrator {
  private readonly d: OrchDeps;
  private scope?: string;

  constructor(deps: OrchDeps) {
    this.d = deps;
  }

  private sharedWith?: (projectPath: string) => boolean;
  private idleSince = new Map<string, number>();

  setScope(key: string, sharedWith?: (projectPath: string) => boolean): void {
    this.scope = key;
    this.sharedWith = sharedWith;
  }

  private mine(t: TaskRecord): boolean {
    if (this.scope === undefined || t.owner_key === this.scope) return true;
    return this.sharedWith !== undefined && this.sharedWith(t.project_path);
  }

  ownsTask(t: TaskRecord): boolean {
    return this.mine(t);
  }

  ownsProject(projectPath: string): boolean {
    return this.scope === undefined || (this.sharedWith?.(projectPath) ?? false);
  }

  private async withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    mkdirSync(this.d.tasksDir, { recursive: true });
    const dir = join(this.d.tasksDir, `${taskId}.oplock`);
    const deadline = Date.now() + OP_LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(dir);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(dir).mtimeMs > OP_LOCK_STALE_MS) {
            rmSync(dir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new Error(`tarefa ${taskId} está ocupada com outra operação; tente de novo`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  owned(): TaskRecord[] {
    return this.list().filter((t) => this.mine(t));
  }

  adoptUnowned(belongs: (projectPath: string) => boolean): number {
    if (this.scope === undefined) return 0;
    const scope = this.scope;
    return this.d.store.mutate((state) => {
      let n = 0;
      for (const t of Object.values(state.tasks)) {
        if (t.owner_key === undefined && belongs(t.project_path)) {
          t.owner_key = scope;
          n++;
        }
      }
      return n;
    });
  }

  private assertMine(taskId: string): void {
    const t = this.get(taskId);
    if (this.mine(t)) return;
    const dono =
      t.owner_key === undefined
        ? "tarefa legada sem dono (o repo dela tem sessão viva ou está fora desta sessão)"
        : `de outra sessão do orquestrador (escopo ${t.owner_key})`;
    throw new Error(`tarefa ${taskId} é ${dono}; esta sessão só age sobre as próprias tarefas`);
  }

  get(taskId: string): TaskRecord {
    const t = this.d.store.load().tasks[taskId];
    if (!t) throw new Error(`tarefa desconhecida: ${taskId}`);
    return t;
  }

  activeCount(): number {
    return this.list().filter((t) => isActive(t.status)).length;
  }

  list(): TaskRecord[] {
    return Object.values(this.d.store.load().tasks).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private iso(ms = this.d.now()): string {
    return new Date(ms).toISOString();
  }

  private update(taskId: string, fn: (t: TaskRecord) => void): TaskRecord {
    return this.d.store.mutate((state) => {
      const t = state.tasks[taskId];
      if (!t) throw new Error(`tarefa desconhecida: ${taskId}`);
      fn(t);
      t.updated_at = this.iso();
      return t;
    });
  }

  private reportPath(t: TaskRecord): string {
    return join(t.task_dir, "report.json");
  }

  private async ensureWorkspace(
    projectPath: string,
    projectId: string,
  ): Promise<{ workspace_id: string; seeded_tab_id: string | null }> {
    const state = this.d.store.load();
    const known = state.workspaces[projectPath];
    if (known && (await this.d.herdr.workspaceIds()).includes(known.workspace_id)) return known;
    const created = await this.d.herdr.createWorkspace({ cwd: projectPath, label: projectId });
    const record = { workspace_id: created.workspace_id, seeded_tab_id: created.seeded_tab_id };
    this.d.store.mutate((s) => {
      s.workspaces[projectPath] = record;
    });
    return record;
  }

  private async closeSurface(t: TaskRecord): Promise<void> {
    if (t.projected) await this.d.herdr.closeWorkspace(t.workspace_id);
    else await this.d.herdr.closeTab(t.tab_id);
  }

  private async assertSpacesFloor(): Promise<void> {
    const v = await this.d.herdr.clientVersion();
    if (belowFloor(v)) {
      throw new Error(
        `workspace por tarefa (PI_ORCH_PRESENTATION_SPACES=1) exige Herdr ${PRESENTATION_FLOOR} ou mais; encontrado: ${v ?? "desconhecido"}. Nada foi lançado.`,
      );
    }
  }

  checkDelegate(input: DelegateInput): void {
    resolveModel(input.model, this.d.availableModels());
    buildIntake({ ...input, model: input.model });
    this.assertNotActive(input);
  }

  checkBatch(inputs: DelegateInput[]): void {
    const seen: DelegateInput[] = [];
    for (const input of inputs) {
      this.checkDelegate(input);
      for (const earlier of seen) {
        const dup = sameWork(earlier, input);
        if (dup) throw new Error(`o lote traz duas tarefas para a mesma ${dup}; nada foi lançado`);
      }
      seen.push(input);
    }
  }

  projectIdFor(projectPath: string): string {
    const base = basename(projectPath);
    const clash = this.list().some((t) => t.project_id === base && t.project_path !== projectPath);
    return clash ? `${basename(dirname(projectPath))}/${base}` : base;
  }

  activeConflict(input: DelegateInput): { task: TaskRecord; label: string } | null {
    for (const t of this.list()) {
      if (!isActive(t.status) || t.project_path !== input.project_path) continue;
      const dup = sameWork(
        { ...input, source: t.source ?? undefined, branch: t.branch ?? undefined, project_path: t.project_path },
        input,
      );
      if (dup) return { task: t, label: dup };
    }
    return null;
  }

  private assertNotActive(input: DelegateInput): void {
    const c = this.activeConflict(input);
    if (c)
      throw new Error(
        `já existe a tarefa ${c.task.task_id} ativa para a mesma ${c.label} (${c.task.status}); aguarde ou cancele antes de lançar outra`,
      );
  }

  async delegate(
    rawInput: DelegateInput,
    opts: { forkSession?: string; briefRevised?: boolean } = {},
  ): Promise<TaskRecord> {
    const input = this.d.enrichSource ? await this.d.enrichSource(rawInput) : rawInput;
    const badRelease = invalidToolRelease(input.allowed_tools ?? []);
    if (badRelease) throw new Error(badRelease);
    this.assertNotActive(input);
    const model = this.d.chooseModel
      ? (await this.d.chooseModel(input.model)).model
      : resolveModel(input.model, this.d.availableModels());
    const projectId = this.projectIdFor(input.project_path);
    const intake = buildIntake({ ...input, model });
    const releases = input.allowed_tools ?? [];
    const toolPolicy = JSON.stringify({ mode: intake.mode, allowed: workerToolSet(intake.mode, releases) });
    const projected = this.d.presentationSpaces === true && !this.d.dryRun;
    if (projected) await this.assertSpacesFloor();

    // keep: orçamento validado antes de qualquer efeito colateral; valor explícito inválido não lança tarefa.
    const dialogueBudget = resolveDialogueBudget(input.dialogue_budget, process.env.PI_ORCH_DIALOGUE_BUDGET);
    const taskId = `t-${this.d.newHex()}`;
    const workerId = workerAgentName(input.project_path, taskId.slice(2));
    const taskDir = join(this.d.tasksDir, taskId);
    const briefPath = join(taskDir, "brief.md");
    const reportPath = join(taskDir, "report.json");
    const ticket = ticketForDelegate(input, model ?? null, { taskId, reportPath });
    mkdirSync(taskDir, { recursive: true });

    writeFileSync(briefPath, maskSecrets(renderBrief(taskId, intake, reportPath)));
    if (ticket) writeFileSync(join(taskDir, TICKET_FILE), `${JSON.stringify(ticket, null, 2)}\n`);

    const deadlineAt = input.timeout_minutes ? this.iso(this.d.now() + input.timeout_minutes * 60_000) : null;
    const initialStatus: TaskStatus = this.d.dryRun ? "planned" : "starting";
    const now = this.iso();
    const record: TaskRecord = {
      task_id: taskId,
      ...(this.scope !== undefined ? { owner_key: this.scope } : {}),
      project_id: projectId,
      project_path: input.project_path,
      source: input.source?.trim() || null,
      branch: input.branch?.trim() || null,
      model: model ?? null,
      mode: input.mode,
      delegate_input: rawInput as unknown as Record<string, unknown>,
      released_tools: releases,
      role: input.role,
      worker_id: workerId,
      workspace_id: "",
      projected,
      tab_id: "",
      pane_id: "",
      terminal_id: "",
      status: initialStatus,
      task_dir: taskDir,
      brief_path: briefPath,
      created_at: now,
      updated_at: now,
      deadline_at: deadlineAt,
      question: null,
      result: null,
      artifacts: [],
      last_report_key: null,
      notified: true,
      error: null,
      dialogue: newDialogue(dialogueBudget),
    };
    this.d.store.mutate((state) => {
      state.tasks[taskId] = record;
    });
    if (this.d.dryRun) return record;

    let tabId: string | undefined;
    let spaceId: string | undefined;
    try {
      let ws: { workspace_id: string };
      let tab: TabResult;
      if (projected) {
        const space = await this.d.herdr.createWorkspace({
          cwd: input.project_path,
          label: workerTabName(input.role, taskId.slice(2)),
        });
        spaceId = space.workspace_id;
        ws = space;
        tab = { tab_id: space.seeded_tab_id, pane_id: space.pane_id, terminal_id: space.terminal_id };
      } else {
        ws = await this.ensureWorkspace(input.project_path, projectId);
        tab = await this.d.herdr.createTab({
          workspaceId: ws.workspace_id,
          cwd: input.project_path,
          label: workerTabName(input.role, taskId.slice(2)),
          env: {
            PI_ORCH_ROLE: "worker",
            // keep: desliga o hook pessoal de PR review nesta sessão; a revisão da Factory é o orch_review_verdict (um review por PR/SHA).
            PI_PR_REVIEW_CHILD: "1",
            PI_ORCH_TASK_ID: taskId,
            PI_ORCH_TASK_DIR: taskDir,
            PI_ORCH_TOOL_POLICY: toolPolicy,
            ...(this.d.hookUrl && this.d.hookToken
              ? { PI_ORCH_HOOK_URL: this.d.hookUrl, PI_ORCH_HOOK_TOKEN: this.d.hookToken }
              : {}),
          },
        });
      }
      tabId = tab.tab_id;
      this.update(taskId, (t) => {
        t.workspace_id = ws.workspace_id;
        t.tab_id = tab.tab_id;
        t.pane_id = tab.pane_id;
        t.terminal_id = tab.terminal_id;
      });
      // keep: o Herdr recusa texto multilinha em argumento; o brief completo chega pela extensão do worker.
      // keep: --tools é lista de permissão; sem ela o worker herdaria todas as ferramentas e servidores MCP do usuário.
      const piArgs = ["-e", this.d.workerExtPath, ...workerToolArgs(intake.mode, releases)];
      if (opts.forkSession) piArgs.push("--fork", opts.forkSession);
      if (model) piArgs.push("--model", model);
      piArgs.push(
        launchMessage(
          join(taskDir, "brief.md"),
          opts.forkSession !== undefined,
          intake.mode,
          opts.briefRevised === true,
        ),
      );
      const launch = ["pi", ...piArgs];
      if (projected)
        // keep: o token do webhook fica fora do pane; qualquer leitura do pane o exporia.
        launch.unshift(
          "env",
          "PI_ORCH_ROLE=worker",
          "PI_PR_REVIEW_CHILD=1",
          `PI_ORCH_TASK_ID=${taskId}`,
          `PI_ORCH_TASK_DIR=${taskDir}`,
          `PI_ORCH_TOOL_POLICY=${toolPolicy}`,
        );
      await this.d.herdr.runInPane(tab.pane_id, launch.map(shellQuote).join(" "));
      await this.d.herdr.renamePane(tab.pane_id, workerId).catch(() => undefined);
      return this.update(taskId, (t) => {
        t.status = "running";
      });
    } catch (err) {
      if (spaceId) await this.d.herdr.closeWorkspace(spaceId).catch(() => undefined);
      else if (tabId) await this.d.herdr.closeTab(tabId).catch(() => undefined);
      this.update(taskId, (t) => {
        t.status = "failed";
        t.error = errorMessage(err);
        t.notified = false;
      });
      throw err;
    }
  }

  collect(taskId: string): boolean {
    const t = this.get(taskId);
    const file = this.reportPath(t);
    if (!existsSync(file)) return false;
    const raw = readFileSync(file, "utf8");
    const key = reportKey(raw);
    if (key === t.last_report_key) return false;
    let report: Report;
    try {
      report = validateReport(JSON.parse(raw), taskId);
    } catch (err) {
      this.update(taskId, (x) => {
        x.last_report_key = key;
        x.error = `relatório inválido ignorado: ${errorMessage(err)}`;
      });
      return false;
    }
    const previous = report.status === "failed" && isFallbackRaw(raw) ? this.lastArchivedDone(t) : null;
    if (previous) {
      this.update(taskId, (x) => {
        x.status = "done";
        x.result = previous.result;
        x.question = null;
        x.artifacts = previous.artifacts;
        x.last_report_key = key;
        x.notified = false;
        x.error = `continuação encerrou sem orch_report; resultado anterior mantido. ${report.result}`;
      });
      this.d.onTerminal?.(taskId);
      return true;
    }
    const samePendingQuestion = t.status === "blocked" && report.status === "blocked" && t.question === report.question;
    const reopened = ["lost", "failed", "timeout"].includes(t.status)
      ? `antes marcada como ${t.status}${t.error ? ` (${t.error})` : ""}; o relatório válido chegou depois e prevalece`
      : null;
    this.update(taskId, (x) => {
      x.status = report.status;
      x.result = report.result;
      x.question = report.question;
      x.pending_ask = null;
      x.artifacts = report.artifacts;
      x.last_report_key = key;
      x.notified = samePendingQuestion ? t.notified : false;
      x.reopened_from = reopened;
      x.error = null;
    });
    this.record(t, {
      from: "worker",
      to: "orquestrador",
      kind: "relatorio",
      status: report.status,
      ref: null,
      text: report.status === "blocked" ? (report.question ?? "") : report.result,
    });
    if (report.status !== "blocked") this.d.onTerminal?.(taskId);
    return true;
  }

  private lastArchivedDone(t: TaskRecord): Report | null {
    let best: { at: number; report: Report } | null = null;
    for (const name of readdirSync(t.task_dir)) {
      if (!/^report-[0-9a-f]+\.json$/.test(name)) continue;
      const path = join(t.task_dir, name);
      try {
        const report = validateReport(JSON.parse(readFileSync(path, "utf8")), t.task_id);
        if (report.status !== "done") continue;
        const at = statSync(path).mtimeMs;
        if (!best || at > best.at) best = { at, report };
      } catch {}
    }
    return best?.report ?? null;
  }

  private toEvent(t: TaskRecord): WatchEvent {
    return {
      task_id: t.task_id,
      project_id: t.project_id,
      status: t.status,
      result: t.result,
      question: t.question,
      artifacts: t.artifacts,
      error: t.error,
      correction: t.reopened_from ?? null,
    };
  }

  private setTerminal(taskId: string, status: TaskStatus, error: string | null): WatchEvent {
    this.idleSince.delete(taskId);
    const t = this.update(taskId, (x) => {
      x.status = status;
      x.error = error;
      x.notified = false;
    });
    this.d.onTerminal?.(taskId);
    return this.toEvent(t);
  }

  async refresh(taskId: string): Promise<WatchEvent | null> {
    this.syncUsage(taskId);
    this.collectAsk(taskId);
    const t = this.get(taskId);
    if (t.status !== "cancelled" && t.status !== "planned" && this.collect(taskId))
      return this.toEvent(this.get(taskId));
    if (
      t.status === "blocked" &&
      t.deadline_at !== null &&
      !t.deadline_notified &&
      this.d.now() >= Date.parse(t.deadline_at)
    ) {
      const at = t.deadline_at;
      this.update(taskId, (x) => {
        x.deadline_notified = true;
        x.notified = false;
        x.error = `o prazo (${at}) venceu enquanto a tarefa aguardava sua resposta; segue bloqueada. Responder, prorrogar ou cancelar?`;
      });
      return this.toEvent(this.get(taskId));
    }
    if (!isActive(t.status) || t.status === "blocked") return null;
    if (t.deadline_at !== null && this.d.now() >= Date.parse(t.deadline_at)) {
      return this.setTerminal(
        taskId,
        "timeout",
        `prazo definido por você (${t.deadline_at}) foi atingido; o worker segue rodando`,
      );
    }
    const { owner, pane } = await this.paneOwnership(t);
    if (owner !== "owned") {
      this.noteWorktree(taskId);
      return this.setTerminal(taskId, "lost", `pane ${owner === "missing" ? "não existe mais" : "trocou de agente"}`);
    }
    return t.status === "running" ? this.failIfIdleWithoutReport(taskId, pane) : null;
  }

  forgetDeadTab(taskId: string): boolean {
    this.assertMine(taskId);
    const t = this.get(taskId);
    if (t.status !== "done" || !t.tab_id) return false;
    this.update(taskId, (x) => {
      x.tab_id = "";
    });
    return true;
  }

  setHook(url: string, token: string): void {
    this.d.hookUrl = url;
    this.d.hookToken = token;
  }

  async refreshAll(): Promise<void> {
    for (const t of this.owned()) {
      if (t.status !== "cancelled") await this.refresh(t.task_id).catch(() => null);
    }
  }

  async close(taskId: string): Promise<TaskRecord> {
    return (await this.closeOutcome(taskId)).task;
  }

  async closeMerged(taskId: string): Promise<{ task: TaskRecord; closed: boolean; reason: string | null }> {
    const outcome = await this.closeOutcome(taskId);
    this.forgetDeadTab(taskId);
    return { ...outcome, task: this.get(taskId) };
  }

  async closeOutcome(taskId: string): Promise<{ task: TaskRecord; closed: boolean; reason: string | null }> {
    return this.withTaskLock(taskId, () => this.closeOutcomeLocked(taskId));
  }

  private async closeOutcomeLocked(
    taskId: string,
  ): Promise<{ task: TaskRecord; closed: boolean; reason: string | null }> {
    this.assertMine(taskId);
    const t = this.get(taskId);
    const owner = await this.ownership(t);
    if (owner === "mismatch") {
      throw new Error(`tab ${t.tab_id} não corresponde mais à tarefa ${taskId}; nada foi fechado`);
    }
    let reason: string | null = null;
    if (owner === "owned") await this.closeSurface(t);
    else reason = "a pane da tarefa não existe mais no Herdr; nada foi fechado";
    const task = this.update(taskId, (x) => {
      x.notified = true;
    });
    return { task, closed: owner === "owned", reason };
  }

  setVerification(
    taskId: string,
    v: { verdict: "approved" | "rejected" | "not_applicable" | "unverified"; reason: string },
  ): void {
    this.update(taskId, (x) => {
      x.verification = v;
    });
  }

  private syncUsage(taskId: string): void {
    const file = join(this.get(taskId).task_dir, "usage.json");
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        total?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          totalTokens?: number;
          cost?: number;
          costFromProvider?: boolean;
        };
        warm?: { cost?: number; warmIds?: string[] };
        turns?: TurnRecord[];
      };
      const u = parsed.total;
      if (!u || typeof u.totalTokens !== "number") return;
      const next = {
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
        cost: u.cost ?? 0,
        costFromProvider: u.costFromProvider === true,
        cacheWarmCost: (parsed.warm?.warmIds?.length ?? 0) > 0 ? (parsed.warm?.cost ?? 0) : null,
        turns: Array.isArray(parsed.turns) ? summarizeTurns(parsed.turns) : null,
        totalTokens: u.totalTokens,
      };
      const cur = this.get(taskId).usage;
      if (cur && JSON.stringify(cur) === JSON.stringify(next)) return;
      this.update(taskId, (x) => {
        x.usage = next;
      });
    } catch {}
  }

  async relaunch(taskId: string, model?: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, () => this.relaunchLocked(taskId, model));
  }

  private async relaunchLocked(taskId: string, model?: string): Promise<TaskRecord> {
    this.assertMine(taskId);
    const old = this.get(taskId);
    if (isActive(old.status)) throw new Error(`tarefa ${taskId} ainda está ativa; use orch_cancel antes de relançar`);
    if (old.status !== "failed")
      throw new Error(`só relança tarefa falha (status: ${old.status}); ${proximoPasso(old.status)}`);
    if (!old.delegate_input)
      throw new Error(`tarefa ${taskId} não tem o pedido guardado; lance de novo com orch_delegate`);
    const reason = old.result ?? old.error ?? "";
    const kind = classifyFailure(reason);
    const report = [old.result, old.error].filter((s): s is string => !!s && s.trim() !== "").join("\n");
    const previous = workerSessionFile(old.task_dir);
    if (kind === "quota") {
      if (!model)
        throw new Error(`falha por cota em ${old.model ?? "modelo padrão"}: informe o modelo do relançamento`);
      if (model === old.model) throw new Error(`o modelo ${model} esgotou a cota; escolha outro`);
    }
    if (kind === "auth" && model && old.model && model.split("/")[0] === old.model.split("/")[0]) {
      throw new Error(`credencial falhou no provedor ${old.model.split("/")[0]}; escolha modelo de outro provedor`);
    }
    const original = (old.delegate_input as unknown as DelegateInput).constraints ?? [];
    const notice = relaunchNotice({
      taskId,
      context: relaunchContext(previous),
      kind,
      reportPath: this.reportPath(old),
      report,
      branch: old.branch ?? null,
      artifacts: old.artifacts,
    });
    const input = {
      ...(old.delegate_input as unknown as DelegateInput),
      model: model ?? old.model ?? undefined,
      constraints: [...original.filter((c) => !c.startsWith(RELAUNCH_MARK)), notice],
    };
    const task = await this.delegate(input, { forkSession: previous ?? undefined, briefRevised: true });
    this.update(task.task_id, (x) => {
      x.relaunched_from = taskId;
      // keep: o relançamento herda o gasto do diálogo; reiniciar a tarefa não pode zerar o orçamento.
      if (old.dialogue) x.dialogue = old.dialogue;
    });
    return this.get(task.task_id);
  }

  reopenNotice(taskId: string): void {
    this.update(taskId, (x) => {
      x.notified = false;
    });
  }

  // keep: check e marcação na mesma trava; ler fora dela deixa duas sessões pegarem o mesmo aviso.
  takeNotice(taskId: string): boolean {
    return this.d.store.mutate((state) => {
      const t = state.tasks[taskId];
      if (!t) throw new Error(`tarefa desconhecida: ${taskId}`);
      if (t.notified) return false;
      t.notified = true;
      t.updated_at = this.iso();
      return true;
    });
  }

  async inbox(opts: { consume?: boolean } = {}): Promise<WatchEvent[]> {
    return (await this.inboxPage(opts)).items;
  }

  async inboxPage(opts: { consume?: boolean; limit?: number } = {}): Promise<{ items: WatchEvent[]; omitted: number }> {
    const consume = opts.consume !== false;
    if (consume) await this.refreshAll();
    const pending = this.owned().filter(
      (t) => t.status === "blocked" || (!t.notified && !isActive(t.status) && t.status !== "cancelled"),
    );
    const ordered = [
      ...pending.filter((t) => t.status === "blocked"),
      ...pending.filter((t) => t.status !== "blocked"),
    ];
    const shown = ordered.slice(0, opts.limit ?? ordered.length);
    for (const t of shown) if (consume && t.status !== "blocked") this.takeNotice(t.task_id);
    return { items: shown.map((t) => this.toEvent(t)), omitted: ordered.length - shown.length };
  }

  private takePending(taskId: string): WatchEvent | null {
    const t = this.get(taskId);
    const pending =
      !t.notified &&
      (t.status === "blocked" || (!isActive(t.status) && t.status !== "cancelled" && t.status !== "planned"));
    if (!pending || !this.takeNotice(taskId)) return null;
    this.update(taskId, (x) => {
      x.delivery_pending = t.status;
    });
    return this.toEvent(t);
  }

  // keep: só a entrega confirmada tira o pendente; se o processo cair antes, pendingNotices() reenvia.
  markDelivered(taskId: string, status: string): void {
    if (this.get(taskId).delivery_pending !== status) return;
    this.update(taskId, (x) => {
      x.delivery_pending = null;
    });
    this.record(this.get(taskId), {
      from: "worker",
      to: "orquestrador",
      kind: "entrega",
      status: "entregue",
      ref: status,
      text: "",
    });
  }

  // keep: pergunta operacional não muda o status; só vira pendente de aviso, nunca blocked nem decisão do usuário.
  private collectAsk(taskId: string): void {
    const t = this.get(taskId);
    if (t.status !== "running") return;
    const ask = latestAsk(t.task_dir);
    if (!ask || ask.id === t.last_ask_id) return;
    // keep: pergunta repetida sem evidência nova não gera sequência ilimitada: a primeira oferece uma estratégia, a segunda bloqueia com resumo para decisão humana.
    const before = t.dialogue ?? newDialogue(DIALOGUE_BUDGET_DEFAULT);
    const verdict = judgeAsk(before, ask);
    const after = recordAsk(before, ask, verdict);
    if (verdict === "progress" || verdict === "redirect") {
      this.update(taskId, (x) => {
        x.last_ask_id = ask.id;
        x.dialogue = after;
        x.pending_ask = {
          id: ask.id,
          question: ask.question,
          context: ask.context,
          notified: false,
          hint: verdict === "redirect" ? redirectHint(after) : null,
        };
      });
    } else {
      // keep: parada do diálogo usa o caminho de decisão já existente (status blocked); não declara sucesso nem responde ao worker.
      this.update(taskId, (x) => {
        x.last_ask_id = ask.id;
        x.dialogue = after;
        x.pending_ask = null;
        x.status = "blocked";
        x.question = stopSummary(after, ask, verdict);
        x.notified = false;
        x.error = null;
      });
    }
    // keep: a cronologia registra toda pergunta nova, entregue ou parada; o registro não altera a decisão.
    this.record(t, {
      from: "worker",
      to: "orquestrador",
      kind: "pergunta",
      status: "registrada",
      ref: ask.id,
      text: ask.question,
    });
  }

  // keep: marca entregue só se a pergunta ainda é a pendente; resposta já enviada não precisa de marca.
  markAskDelivered(taskId: string, askId: string): void {
    const first = this.d.store.mutate((state) => {
      const t = state.tasks[taskId];
      if (!t?.pending_ask || t.pending_ask.id !== askId || t.pending_ask.delivered) return false;
      t.pending_ask.delivered = true;
      t.updated_at = this.iso();
      return true;
    });
    if (first)
      this.record(this.get(taskId), {
        from: "worker",
        to: "orquestrador",
        kind: "entrega",
        status: "entregue",
        ref: askId,
        text: "",
      });
  }

  markEventDelivered(e: WatchEvent): void {
    if (e.kind === "ask" && e.ask_id !== undefined) this.markAskDelivered(e.task_id, e.ask_id);
    else this.markDelivered(e.task_id, e.status);
  }

  private takeAsk(taskId: string): WatchEvent | null {
    const pending = this.d.store.mutate((state) => {
      const t = state.tasks[taskId];
      if (!t) throw new Error(`tarefa desconhecida: ${taskId}`);
      if (!t.pending_ask || t.pending_ask.notified) return null;
      t.pending_ask.notified = true;
      t.updated_at = this.iso();
      return { ...t.pending_ask };
    });
    if (!pending) return null;
    return {
      ...this.toEvent(this.get(taskId)),
      kind: "ask",
      ask_id: pending.id,
      question: pending.question,
      result: pending.context || null,
      hint: pending.hint ?? null,
    };
  }

  async noticeFor(taskId: string): Promise<WatchEvent | null> {
    if (!this.mine(this.get(taskId))) return null;
    await this.refresh(taskId).catch(() => null);
    return this.takeAsk(taskId) ?? this.takePending(taskId);
  }

  async sweep(): Promise<WatchEvent[]> {
    const out: WatchEvent[] = [];
    for (const t of this.owned()) {
      if (t.status === "cancelled") continue;
      const ev = await this.noticeFor(t.task_id);
      if (ev) out.push(ev);
    }
    return out;
  }

  async pendingNotices(): Promise<WatchEvent[]> {
    const out = await this.sweep();
    const seen = new Set(out.filter((e) => e.kind !== "ask").map((e) => e.task_id));
    const asked = new Set(out.filter((e) => e.kind === "ask").map((e) => e.task_id));
    // keep: pendente só volta se ainda é o estado atual; pergunta já respondida não é reenviada.
    for (const t of this.owned()) {
      if (t.delivery_pending !== t.status || seen.has(t.task_id)) continue;
      out.push(this.toEvent(t));
    }
    // keep: pergunta reivindicada mas não entregue (queda entre o aviso e o LLM) volta no início, uma vez.
    for (const t of this.owned()) {
      const p = t.pending_ask;
      if (!p || p.delivered || asked.has(t.task_id) || t.status !== "running") continue;
      out.push({
        ...this.toEvent(t),
        kind: "ask",
        ask_id: p.id,
        question: p.question,
        result: p.context || null,
        hint: p.hint ?? null,
      });
    }
    return out;
  }

  // keep: cronologia é leitura pura; mesma regra de dono das demais ações, e o texto sai compacto salvo detail.
  history(taskId: string, opts: { limit?: number; offset?: number; detail?: boolean }): HistoryPage {
    this.assertMine(taskId);
    return readHistory(this.get(taskId).task_dir, opts);
  }

  // keep: cronologia é observabilidade; falha de gravação não pode fazer um envio já entregue parecer falho.
  private record(t: TaskRecord, e: Omit<HistoryInput, "at">): void {
    try {
      appendHistory(t.task_dir, { ...e, at: this.iso() });
    } catch {}
  }

  private recordSend(
    t: TaskRecord,
    text: string,
    kind: "mensagem" | "resposta",
    ref: string | null,
    status: "enviada" | "falhou",
  ): void {
    this.record(t, { from: "orquestrador", to: "worker", kind, status, ref, text });
  }

  async logs(taskId: string, lines?: number): Promise<string> {
    const t = this.get(taskId);
    const owner = await this.ownership(t);
    if (owner === "missing") throw new Error("o painel da tarefa não existe mais; nada foi lido");
    if (owner === "mismatch") throw new Error("o painel trocou de agente; nada foi lido");
    try {
      return maskSecrets(await this.d.herdr.readRecent(t.pane_id, clampLines(lines)));
    } catch (err) {
      throw logError(err);
    }
  }

  // keep: askId liga a resposta à pergunta; a checagem roda sob a trava, então replay ou corrida não envia duas vezes.
  async send(taskId: string, text: string, askId?: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, () => this.sendLocked(taskId, text, askId));
  }

  private async sendLocked(taskId: string, text: string, askId?: string): Promise<TaskRecord> {
    this.assertMine(taskId);
    const t = this.get(taskId);
    if (t.status !== "running" && t.status !== "blocked" && t.status !== "done")
      throw new Error(`tarefa ${taskId} não aceita mensagem (status: ${t.status}); ${proximoPasso(t.status)}`);
    if (text.trim() === "") throw new Error("mensagem vazia");
    if (askId !== undefined) {
      if (t.last_answered_ask_id === askId) throw new Error(`pergunta ${askId} já foi respondida; nada foi enviado`);
      if (t.status !== "running" || t.pending_ask?.id !== askId)
        throw new Error(`pergunta ${askId} não está pendente nesta tarefa; nada foi enviado`);
    } else if (t.pending_ask) {
      // keep: sem ask_id, um replay após crash reenviaria a resposta; por isso a recusa cita o id pendente.
      throw new Error(
        `há pergunta pendente ${t.pending_ask.id}; responda com orch_send ask_id="${t.pending_ask.id}"; nada foi enviado`,
      );
    }
    const body = askId === undefined ? text : this.oracleAnswerText(t, askId, text);
    const owner = await this.ownership(t);
    if (owner === "missing")
      throw this.sendError(
        t,
        "o painel da tarefa não existe mais; nada foi enviado",
        "confira com orch_status antes de qualquer nova tentativa; não reenvie a outro painel.",
      );
    if (owner === "mismatch")
      throw this.sendError(
        t,
        "o painel trocou de agente; nada foi enviado",
        "confira com orch_status; a resposta não vai para outro agente.",
      );
    if (t.status === "blocked") return this.answerLocked(taskId, body);
    if (t.status === "done") {
      const pane = (await this.d.herdr.panes()).find((p) => p.pane_id === t.pane_id && p.terminal_id === t.terminal_id);
      // keep: o Herdr reporta "done" no painel de quem já terminou a vez; é o mesmo estado de espera por mensagem que "idle".
      const waiting = pane?.agent_status === "idle" || pane?.agent_status === "done";
      if (!pane || pane.agent !== "pi" || !waiting)
        throw new Error("o worker não está disponível e ocioso; nada foi enviado");
      if (t.delegate_input) this.assertNotActive(t.delegate_input as unknown as DelegateInput);
      const report = this.reportPath(t);
      const previous = join(t.task_dir, `report-${this.d.newHex()}.json`);
      if (existsSync(report)) renameSync(report, previous);
      this.update(taskId, (x) => {
        x.status = "running";
        x.notified = true;
        x.question = null;
      });
      try {
        await this.d.herdr.prompt(t.pane_id, body);
      } catch (err) {
        this.recordSend(t, body, "mensagem", null, "falhou");
        if (existsSync(previous) && !existsSync(report)) renameSync(previous, report);
        this.update(taskId, (x) => {
          x.status = "done";
          x.notified = t.notified;
        });
        throw err;
      }
      this.recordSend(t, body, "mensagem", null, "enviada");
      return this.get(taskId);
    }
    // keep: a pergunta só sai do pendente depois do envio; falha no painel deixa a retentativa possível.
    const answered = t.pending_ask?.id;
    try {
      await this.d.herdr.prompt(t.pane_id, body);
    } catch (err) {
      this.recordSend(t, body, answered === undefined ? "mensagem" : "resposta", answered ?? null, "falhou");
      if (answered === undefined) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw this.sendError(
        t,
        `falha ao enviar ao painel: ${detail}; nada foi confirmado`,
        `confira com orch_logs se o worker recebeu; se não recebeu, repita orch_send(task_id, text, ask_id="${answered}").`,
      );
    }
    this.recordSend(t, body, answered === undefined ? "mensagem" : "resposta", answered ?? null, "enviada");
    if (answered !== undefined) {
      // keep: só limpa se a pergunta ainda é a respondida; uma nova coletada durante o envio fica pendente.
      this.update(taskId, (x) => {
        if (x.pending_ask?.id === answered) x.pending_ask = null;
        x.last_answered_ask_id = answered;
      });
    }
    return t;
  }

  // keep: resposta a pergunta do worker só segue com parecer answered gravado; inconclusivo, contraditório ou fora do escopo não vira orientação.
  private oracleAnswerText(t: TaskRecord, askId: string, text: string): string {
    const verdict = oracleVerdictFor(t.task_dir, askId);
    if (verdict !== "answered")
      throw new Error(
        `sem parecer do Oracle que autorize a pergunta ${askId} (parecer: ${verdict ?? "nenhum"}); nada foi enviado`,
      );
    return `[resposta à pergunta ${askId}] ${text}`;
  }

  // keep: com pergunta pendente, a falha grava o motivo e mantém a pergunta para retentativa; sem pergunta, a mensagem é a de sempre.
  private sendError(t: TaskRecord, motivo: string, proximo: string): Error {
    const pending = t.pending_ask;
    if (!pending) return new Error(motivo);
    this.update(t.task_id, (x) => {
      if (x.pending_ask?.id === pending.id) x.pending_ask.send_error = motivo;
    });
    return new Error(`${motivo}. A pergunta ${pending.id} segue pendente: ${proximo}`);
  }

  async answer(taskId: string, text: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, () => this.answerLocked(taskId, text));
  }

  private async answerLocked(taskId: string, text: string): Promise<TaskRecord> {
    this.assertMine(taskId);
    const t = this.get(taskId);
    if (t.status !== "blocked")
      throw new Error(`tarefa ${taskId} não está bloqueada (status: ${t.status}); ${proximoPasso(t.status)}`);
    if (text.trim() === "") throw new Error("resposta vazia");
    try {
      await this.d.herdr.prompt(t.pane_id, text);
    } catch (err) {
      this.recordSend(t, text, "resposta", null, "falhou");
      throw err;
    }
    this.recordSend(t, text, "resposta", null, "enviada");
    return this.update(taskId, (x) => {
      x.status = "running";
      x.question = null;
      x.notified = true;
    });
  }

  private async ownership(t: TaskRecord): Promise<"owned" | "missing" | "mismatch"> {
    return (await this.paneOwnership(t)).owner;
  }

  private async paneOwnership(
    t: TaskRecord,
  ): Promise<{ owner: "owned" | "missing" | "mismatch"; pane: PaneInfo | null }> {
    const pane = (await this.d.herdr.panes()).find((p) => p.pane_id === t.pane_id) ?? null;
    if (!pane) return { owner: "missing", pane: null };
    return { owner: pane.terminal_id === t.terminal_id ? "owned" : "mismatch", pane };
  }

  // keep: o relógio só corre com pane ocioso ou aguardando; qualquer trabalho zera a contagem.
  private failIfIdleWithoutReport(taskId: string, pane: PaneInfo | null): WatchEvent | null {
    const waiting = pane?.agent_status === "idle" || pane?.agent_status === "done";
    if (!waiting) {
      this.idleSince.delete(taskId);
      return null;
    }
    const now = this.d.now();
    const since = this.idleSince.get(taskId) ?? now;
    this.idleSince.set(taskId, since);
    if (now - since < IDLE_NO_REPORT_MS) return null;
    this.idleSince.delete(taskId);
    const min = Math.round(IDLE_NO_REPORT_MS / 60_000);
    const ask = this.get(taskId).pending_ask;
    const error = ask
      ? `worker ficou ocioso por ${min} min aguardando resposta à pergunta "${ask.question.slice(0, 160)}"; a resposta não chegou. Responda com orch_send ou relance se necessário.`
      : `worker ficou ocioso por ${min} min sem chamar orch_report; a tarefa não entregou relatório. Veja orch_logs e relance se necessário.`;
    return this.setTerminal(taskId, "failed", error);
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, () => this.cancelLocked(taskId));
  }

  private async cancelLocked(taskId: string): Promise<TaskRecord> {
    this.assertMine(taskId);
    const t = this.get(taskId);
    if (!isActive(t.status)) return t;
    const owner = await this.ownership(t);
    if (owner === "mismatch") {
      throw new Error(`pane ${t.pane_id} não corresponde mais à tarefa ${taskId}; nada foi encerrado`);
    }
    if (owner === "owned") await this.closeSurface(t);
    this.update(taskId, (x) => {
      x.status = "cancelled";
      x.notified = true;
    });
    this.noteWorktree(taskId);
    return this.get(taskId);
  }

  private noteWorktree(taskId: string): void {
    const t = this.get(taskId);
    let note: string | null = null;
    try {
      note = this.d.releaseWorktree?.(t) ?? null;
    } catch (err) {
      note = `falha ao devolver a worktree: ${String(err).slice(0, 160)}`;
    }
    if (note !== null)
      this.update(taskId, (x) => {
        x.worktree_note = note;
      });
  }

  release(taskId: string): TaskRecord {
    this.assertMine(taskId);
    const t = this.get(taskId);
    if (isActive(t.status))
      throw new Error(`tarefa ${taskId} ainda está ${t.status}; devolva a worktree só depois que terminar`);
    this.noteWorktree(taskId);
    return this.get(taskId);
  }

  async reconcile(): Promise<void> {
    await this.refreshAll();
  }
}
