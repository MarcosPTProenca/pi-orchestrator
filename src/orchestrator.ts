import { workerSessionFile } from "./session-file.ts";
import { resolveModel } from "./models.ts";
import { workerAgentName, workerTabName } from "./label.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { clampLines, maskSecrets } from "./logs.ts";
import { classifyFailure } from "./failure.ts";
import { isActive, reportKey, validateReport, type TaskRecord, type TaskStatus } from "./contract.ts";
import type { Report } from "./contract.ts";
import { belowFloor, PRESENTATION_FLOOR, type HerdrPort, type TabResult } from "./herdr.ts";
import type { Store } from "./store.ts";

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

export { MODES } from "./intake.ts";
import { buildIntake, renderBrief, type Mode } from "./intake.ts";

const OP_LOCK_WAIT_MS = 5_000;
const OP_LOCK_STALE_MS = 30_000;

export interface DelegateInput {
  project_path: string;
  role: string;
  request: string;
  objective: string;
  mode: Mode;
  constraints?: string[];
  source?: string;
  branch?: string;
  spec?: string;
  model?: string;
  tracker?: "github" | "plane" | "none";
  timeout_minutes?: number;
}

function sameWork(a: DelegateInput, b: DelegateInput): string | null {
  if (a.project_path !== b.project_path) return null;
  const sa = a.source?.trim();
  if (sa && sa === b.source?.trim()) return `PR (${sa})`;
  const ba = a.branch?.trim();
  if (ba && ba === b.branch?.trim()) return `branch ${ba}`;
  return null;
}

export interface WatchEvent {
  task_id: string;
  project_id: string;
  status: TaskStatus;
  result: string | null;
  question: string | null;
  artifacts: string[];
  error: string | null;
  correction?: string | null;
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
const LAUNCH_MESSAGE = "Execute a tarefa do brief que voce recebeu no contexto. Ao terminar, chame orch_report.";

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

  setScope(key: string, sharedWith?: (projectPath: string) => boolean): void {
    this.scope = key;
    this.sharedWith = sharedWith;
  }

  private mine(t: TaskRecord): boolean {
    if (this.scope === undefined || t.owner_key === this.scope) return true;
    return this.sharedWith !== undefined && this.sharedWith(t.project_path);
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

  async delegate(rawInput: DelegateInput, opts: { forkSession?: string } = {}): Promise<TaskRecord> {
    const input = this.d.enrichSource ? await this.d.enrichSource(rawInput) : rawInput;
    this.assertNotActive(input);
    const model = this.d.chooseModel
      ? (await this.d.chooseModel(input.model)).model
      : resolveModel(input.model, this.d.availableModels());
    const projectId = this.projectIdFor(input.project_path);
    const intake = buildIntake({ ...input, model });
    const projected = this.d.presentationSpaces === true && !this.d.dryRun;
    if (projected) await this.assertSpacesFloor();

    const taskId = `t-${this.d.newHex()}`;
    const workerId = workerAgentName(input.project_path, taskId.slice(2));
    const taskDir = join(this.d.tasksDir, taskId);
    mkdirSync(taskDir, { recursive: true });
    const briefPath = join(taskDir, "brief.md");
    const reportPath = join(taskDir, "report.json");

    writeFileSync(briefPath, renderBrief(taskId, intake, reportPath));

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
            PI_ORCH_TASK_ID: taskId,
            PI_ORCH_TASK_DIR: taskDir,
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
      const piArgs = ["-e", this.d.workerExtPath];
      if (opts.forkSession) piArgs.push("--fork", opts.forkSession);
      if (model) piArgs.push("--model", model);
      piArgs.push(LAUNCH_MESSAGE);
      const launch = ["pi", ...piArgs];
      if (projected)
        // keep: o token do webhook fica fora do pane; qualquer leitura do pane o exporia.
        launch.unshift("env", "PI_ORCH_ROLE=worker", `PI_ORCH_TASK_ID=${taskId}`, `PI_ORCH_TASK_DIR=${taskDir}`);
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
      x.artifacts = report.artifacts;
      x.last_report_key = key;
      x.notified = samePendingQuestion ? t.notified : false;
      x.reopened_from = reopened;
      x.error = null;
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
    const owner = await this.ownership(t);
    if (owner !== "owned") {
      this.noteWorktree(taskId);
      return this.setTerminal(taskId, "lost", `pane ${owner === "missing" ? "não existe mais" : "trocou de agente"}`);
    }
    return null;
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
        warm?: { cost?: number };
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
        cacheWarmCost: parsed.warm?.cost ?? 0,
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
    if (isActive(old.status)) throw new Error(`tarefa ${taskId} ainda está ativa; cancele antes de relançar`);
    if (old.status !== "failed") throw new Error(`só relança tarefa falha (status: ${old.status})`);
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
    const input = {
      ...(old.delegate_input as unknown as DelegateInput),
      model: model ?? old.model ?? undefined,
      constraints: [
        ...((old.delegate_input as unknown as DelegateInput).constraints ?? []),
        `Tentativa anterior (${taskId}) falhou. Relatório completo:\n${report || "sem detalhe"}\n${
          previous
            ? "A conversa da tentativa anterior foi copiada para esta sessão: leia o histórico antes de refazer. Confira o que já existe antes de refazer."
            : "Sem conversa da tentativa anterior disponível. Confira o que já existe antes de refazer."
        }`,
      ],
    };
    const task = await this.delegate(input, { forkSession: previous ?? undefined });
    this.update(task.task_id, (x) => {
      x.relaunched_from = taskId;
    });
    return this.get(task.task_id);
  }

  reopenNotice(taskId: string): void {
    this.update(taskId, (x) => {
      x.notified = false;
    });
  }

  takeNotice(taskId: string): boolean {
    const t = this.get(taskId);
    if (t.notified) return false;
    this.update(taskId, (x) => {
      x.notified = true;
    });
    return true;
  }

  async inbox(): Promise<WatchEvent[]> {
    await this.refreshAll();
    const items: WatchEvent[] = [];
    for (const t of this.owned()) {
      if (t.status === "blocked") items.push(this.toEvent(t));
      else if (!t.notified && !isActive(t.status) && t.status !== "cancelled") {
        items.push(this.toEvent(t));
        this.takeNotice(t.task_id);
      }
    }
    return items;
  }

  private takePending(taskId: string): WatchEvent | null {
    const t = this.get(taskId);
    const pending =
      !t.notified &&
      (t.status === "blocked" || (!isActive(t.status) && t.status !== "cancelled" && t.status !== "planned"));
    if (!pending) return null;
    this.takeNotice(taskId);
    return this.toEvent(t);
  }

  async noticeFor(taskId: string): Promise<WatchEvent | null> {
    if (!this.mine(this.get(taskId))) return null;
    await this.refresh(taskId).catch(() => null);
    return this.takePending(taskId);
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
    return this.sweep();
  }

  async logs(taskId: string, lines?: number): Promise<string> {
    const t = this.get(taskId);
    const owner = await this.ownership(t);
    if (owner === "missing") throw new Error("o painel da tarefa não existe mais; nada foi lido");
    if (owner === "mismatch") throw new Error("o painel trocou de agente; nada foi lido");
    return maskSecrets(await this.d.herdr.readRecent(t.pane_id, clampLines(lines)));
  }

  async send(taskId: string, text: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, () => this.sendLocked(taskId, text));
  }

  private async sendLocked(taskId: string, text: string): Promise<TaskRecord> {
    this.assertMine(taskId);
    const t = this.get(taskId);
    if (t.status !== "running" && t.status !== "blocked" && t.status !== "done")
      throw new Error(`tarefa ${taskId} não aceita mensagem (status: ${t.status})`);
    if (text.trim() === "") throw new Error("mensagem vazia");
    const owner = await this.ownership(t);
    if (owner === "missing") throw new Error("o painel da tarefa não existe mais; nada foi enviado");
    if (owner === "mismatch") throw new Error("o painel trocou de agente; nada foi enviado");
    if (t.status === "blocked") return this.answerLocked(taskId, text);
    if (t.status === "done") {
      const pane = (await this.d.herdr.panes()).find((p) => p.pane_id === t.pane_id && p.terminal_id === t.terminal_id);
      if (!pane || pane.agent !== "pi" || pane.agent_status !== "idle")
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
        await this.d.herdr.prompt(t.pane_id, text);
      } catch (err) {
        if (existsSync(previous) && !existsSync(report)) renameSync(previous, report);
        this.update(taskId, (x) => {
          x.status = "done";
          x.notified = t.notified;
        });
        throw err;
      }
      return this.get(taskId);
    }
    await this.d.herdr.prompt(t.pane_id, text);
    return t;
  }

  async answer(taskId: string, text: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, () => this.answerLocked(taskId, text));
  }

  private async answerLocked(taskId: string, text: string): Promise<TaskRecord> {
    this.assertMine(taskId);
    const t = this.get(taskId);
    if (t.status !== "blocked") throw new Error(`tarefa ${taskId} não está bloqueada (status: ${t.status})`);
    if (text.trim() === "") throw new Error("resposta vazia");
    await this.d.herdr.prompt(t.pane_id, text);
    return this.update(taskId, (x) => {
      x.status = "running";
      x.question = null;
      x.notified = true;
    });
  }

  private async ownership(t: TaskRecord): Promise<"owned" | "missing" | "mismatch"> {
    const pane = (await this.d.herdr.panes()).find((p) => p.pane_id === t.pane_id);
    if (!pane) return "missing";
    return pane.terminal_id === t.terminal_id ? "owned" : "mismatch";
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
