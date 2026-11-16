/**
 * Núcleo do orquestrador: delegação, acompanhamento, respostas, cancelamento
 * e reconciliação. Não chama LLM. Recebe o Herdr e o estado por injeção.
 */
import { resolveModel } from "./models.ts";
import { workerAgentName } from "./label.ts";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  isActive,
  reportKey,
  validateReport,
  type TaskRecord,
  type TaskStatus,
} from "./contract.ts";
import type { HerdrPort } from "./herdr.ts";
import type { Store } from "./store.ts";

export interface OrchDeps {
  herdr: HerdrPort;
  store: Store;
  tasksDir: string;
  workerExtPath: string;
  now: () => number;
  newHex: () => string;
  /** provider/id dos modelos disponíveis. Modelo pedido fora desta lista é erro explícito. */
  availableModels: () => string[];
  /** true: valida, monta o brief e registra o plano, sem tocar no Herdr. Usado pelos testes de comportamento. */
  dryRun: boolean;
  /** Escolhe o modelo antes do lançamento: pedido explícito é validado; sem pedido, usa a ordem por cota. */
  chooseModel?: (requested: string | undefined) => Promise<{ model: string | undefined; reason: string }>;
  /** Webhook do orquestrador: o worker faz POST nele ao terminar. Definido quando o servidor sobe. */
  hookUrl?: string;
  hookToken?: string;
  /** Chamado quando uma tarefa passa a terminal (a fila de PRs usa isso para avançar). */
  onTerminal?: (taskId: string) => void;
}

export { MODES, type Mode } from "./intake.ts";
import { buildIntake, renderBrief, type Mode } from "./intake.ts";

export interface DelegateInput {
  project_path: string;
  role: string;
  /** Pedido do usuário, literal. */
  request: string;
  /** Objetivo verificável. */
  objective: string;
  mode: Mode;
  constraints?: string[];
  source?: string;
  branch?: string;
  spec?: string;
  /** Modelo exato (provider/id). Omitido: padrão do Pi. */
  model?: string;
  tracker?: "github" | "plane" | "none";
  timeout_minutes?: number;
}

export interface WatchEvent {
  task_id: string;
  project_id: string;
  status: TaskStatus;
  result: string | null;
  question: string | null;
  artifacts: string[];
  error: string | null;
}

const LAUNCH_MESSAGE = "Execute a tarefa do brief que voce recebeu no contexto. Ao terminar, chame orch_report.";
/** Teto para o worker começar a trabalhar após o prompt. Evita ler `idle` anterior ao início. */

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Orchestrator {
  private readonly d: OrchDeps;

  constructor(deps: OrchDeps) {
    this.d = deps;
  }

  get(taskId: string): TaskRecord {
    const t = this.d.store.load().tasks[taskId];
    if (!t) throw new Error(`tarefa desconhecida: ${taskId}`);
    return t;
  }

  list(): TaskRecord[] {
    return Object.values(this.d.store.load().tasks).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private iso(ms = this.d.now()): string {
    return new Date(ms).toISOString();
  }

  private update(taskId: string, fn: (t: TaskRecord) => void): TaskRecord {
    const state = this.d.store.load();
    const t = state.tasks[taskId];
    if (!t) throw new Error(`tarefa desconhecida: ${taskId}`);
    fn(t);
    t.updated_at = this.iso();
    this.d.store.save(state);
    return t;
  }

  private reportPath(t: TaskRecord): string {
    return join(t.task_dir, "report.json");
  }

  /**
   * Um workspace Herdr por projeto, reutilizado enquanto existir. Não divide o pane do orquestrador.
   */
  private async ensureWorkspace(projectPath: string, projectId: string): Promise<{ workspace_id: string; seeded_tab_id: string | null }> {
    const state = this.d.store.load();
    const known = state.workspaces[projectPath];
    if (known && (await this.d.herdr.workspaceIds()).includes(known.workspace_id)) return known;
    const created = await this.d.herdr.createWorkspace({ cwd: projectPath, label: projectId });
    const record = { workspace_id: created.workspace_id, seeded_tab_id: created.seeded_tab_id };
    state.workspaces[projectPath] = record;
    this.d.store.save(state);
    return record;
  }

  /** Valida uma delegação sem efeitos: modelo, projeto, pedido, objetivo e modo. Lança erro explícito. */
  checkDelegate(input: DelegateInput): void {
    resolveModel(input.model, this.d.availableModels());
    buildIntake({ ...input, model: input.model });
  }

  async delegate(input: DelegateInput): Promise<TaskRecord> {
    // Tudo que pode falhar acontece antes de qualquer efeito: nenhum worker é lançado com entrada inválida.
    const model = this.d.chooseModel
      ? (await this.d.chooseModel(input.model)).model
      : resolveModel(input.model, this.d.availableModels());
    const projectId = basename(input.project_path);
    const intake = buildIntake({ ...input, model });

    const taskId = `t-${this.d.newHex()}`;
    const workerId = workerAgentName(input.project_path, taskId.slice(2));
    const taskDir = join(this.d.tasksDir, taskId);
    mkdirSync(taskDir, { recursive: true });
    const briefPath = join(taskDir, "brief.md");
    const reportPath = join(taskDir, "report.json");

    writeFileSync(briefPath, renderBrief(taskId, intake, reportPath));

    // Prazo só existe se o usuário pediu. Sem prazo, o worker segue até terminar.
    const deadlineAt = input.timeout_minutes ? this.iso(this.d.now() + input.timeout_minutes * 60_000) : null;
    const initialStatus: TaskStatus = this.d.dryRun ? "planned" : "starting";
    const now = this.iso();
    const record: TaskRecord = {
      task_id: taskId,
      project_id: projectId,
      project_path: input.project_path,
      model: model ?? null,
      role: input.role,
      worker_id: workerId,
      workspace_id: "",
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
      prompt_attempts: 1,
      worker_started: false,
    };
    const state = this.d.store.load();
    state.tasks[taskId] = record;
    this.d.store.save(state);
    if (this.d.dryRun) return record;

    let tabId: string | undefined;
    try {
      const ws = await this.ensureWorkspace(input.project_path, projectId);
      const tab = await this.d.herdr.createTab({
        workspaceId: ws.workspace_id,
        cwd: input.project_path,
        label: `${input.role}-${taskId.slice(-6)}`,
        env: {
          PI_ORCH_ROLE: "worker",
          PI_ORCH_TASK_ID: taskId,
          PI_ORCH_TASK_DIR: taskDir,
          ...(this.d.hookUrl && this.d.hookToken ? { PI_ORCH_HOOK_URL: this.d.hookUrl, PI_ORCH_HOOK_TOKEN: this.d.hookToken } : {}),
        },
      });
      tabId = tab.tab_id;
      this.update(taskId, (t) => {
        t.workspace_id = ws.workspace_id;
        t.tab_id = tab.tab_id;
        t.pane_id = tab.pane_id;
        t.terminal_id = tab.terminal_id;
      });
      // Argumento inicial curto e seguro para o shell. O brief completo chega pela extensão do worker,
      // que o injeta como contexto antes do primeiro turno (o Herdr recusa texto multilinha em argumento).
      const piArgs = ["-e", this.d.workerExtPath];
      if (model) piArgs.push("--model", model);
      piArgs.push(LAUNCH_MESSAGE);
      await this.d.herdr.startAgent({ name: workerId, paneId: tab.pane_id, piArgs, timeoutMs: 60_000 });
      return this.update(taskId, (t) => {
        t.status = "running";
      });
    } catch (err) {
      if (tabId) await this.d.herdr.closeTab(tabId).catch(() => undefined);
      this.update(taskId, (t) => {
        t.status = "failed";
        t.error = errorMessage(err);
        t.notified = false;
      });
      throw err;
    }
  }

  /**
   * Lê `report.json` se houver conteúdo novo. Devolve true quando aplicou um relatório.
   * Conteúdo idêntico ao já processado é ignorado (deduplicação).
   */
  collect(taskId: string): boolean {
    const t = this.get(taskId);
    const file = this.reportPath(t);
    if (!existsSync(file)) return false;
    const raw = readFileSync(file, "utf8");
    const key = reportKey(raw);
    if (key === t.last_report_key) return false;
    try {
      const report = validateReport(JSON.parse(raw), taskId);
      this.update(taskId, (x) => {
        x.status = report.status;
        x.result = report.result;
        x.question = report.question;
        x.artifacts = report.artifacts;
        x.last_report_key = key;
        x.notified = false;
        x.error = null;
      });
      if (report.status !== "blocked") this.d.onTerminal?.(taskId);
    } catch (err) {
      this.update(taskId, (x) => {
        x.status = "failed";
        x.error = `relatório inválido: ${errorMessage(err)}`;
        x.last_report_key = key;
        x.notified = false;
      });
    }
    return true;
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

  /**
   * Atualiza uma tarefa a partir do disco (relatório) e do Herdr (pane). Não espera nada.
   * O worker avisa o orquestrador ao terminar; esta leitura só confirma o estado e detecta perda ou prazo.
   */
  async refresh(taskId: string): Promise<WatchEvent | null> {
    const t = this.get(taskId);
    if (!isActive(t.status) || t.status === "blocked") return null;
    if (this.collect(taskId)) return this.toEvent(this.get(taskId));
    if (t.deadline_at !== null && this.d.now() >= Date.parse(t.deadline_at)) {
      return this.setTerminal(taskId, "timeout", `prazo definido por você (${t.deadline_at}) foi atingido; o worker segue rodando`);
    }
    const owner = await this.ownership(t);
    if (owner !== "owned") {
      return this.setTerminal(taskId, "lost", `pane ${owner === "missing" ? "não existe mais" : "trocou de agente"}`);
    }
    return null;
  }

  /** Registra o endereço do webhook para os workers lançados daqui em diante. */
  setHook(url: string, token: string): void {
    this.d.hookUrl = url;
    this.d.hookToken = token;
  }

  /** Atualiza todas as tarefas ativas. Chamado por inbox, status e ao iniciar. */
  async refreshAll(): Promise<void> {
    for (const t of this.list()) {
      if (isActive(t.status)) await this.refresh(t.task_id).catch(() => null);
    }
  }

  /**
   * Fecha a tab do worker. Quem decide é o orquestrador, depois de validar o resultado:
   * conclusão não fecha nada sozinha. Dono confirmado por pane_id + terminal_id.
   */
  async close(taskId: string): Promise<TaskRecord> {
    const t = this.get(taskId);
    const owner = await this.ownership(t);
    if (owner === "mismatch") {
      throw new Error(`tab ${t.tab_id} não corresponde mais à tarefa ${taskId}; nada foi fechado`);
    }
    if (owner === "owned") await this.d.herdr.closeTab(t.tab_id);
    return this.update(taskId, (x) => {
      x.notified = true;
    });
  }

  /** Lembrete enviado ao worker que ficou ocioso: uma linha, sem quebras. */
  /** Devolve o aviso pendente e o marca como entregue. Evita repetir o mesmo evento. */
  takeNotice(taskId: string): boolean {
    const t = this.get(taskId);
    if (t.notified) return false;
    this.update(taskId, (x) => {
      x.notified = true;
    });
    return true;
  }

  /** Decisões abertas (blocked) e terminais ainda não entregues. Atualiza antes; marca os terminais como entregues. */
  async inbox(): Promise<WatchEvent[]> {
    await this.refreshAll();
    const items: WatchEvent[] = [];
    for (const t of this.list()) {
      if (t.status === "blocked") items.push(this.toEvent(t));
      else if (!t.notified && !isActive(t.status) && t.status !== "cancelled") {
        items.push(this.toEvent(t));
        this.takeNotice(t.task_id);
      }
    }
    return items;
  }

  async answer(taskId: string, text: string): Promise<TaskRecord> {
    const t = this.get(taskId);
    if (t.status !== "blocked") throw new Error(`tarefa ${taskId} não está bloqueada (status: ${t.status})`);
    if (text.trim() === "") throw new Error("resposta vazia");
    await this.d.herdr.prompt(t.worker_id, text);
    return this.update(taskId, (x) => {
      x.status = "running";
      x.question = null;
      x.notified = true;
    });
  }

  /** Confere se o pane registrado ainda é o mesmo (pane_id e terminal_id). */
  private async ownership(t: TaskRecord): Promise<"owned" | "missing" | "mismatch"> {
    const pane = (await this.d.herdr.panes()).find((p) => p.pane_id === t.pane_id);
    if (!pane) return "missing";
    return pane.terminal_id === t.terminal_id ? "owned" : "mismatch";
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    const t = this.get(taskId);
    if (!isActive(t.status)) return t;
    const owner = await this.ownership(t);
    if (owner === "mismatch") {
      throw new Error(`pane ${t.pane_id} não corresponde mais à tarefa ${taskId}; nada foi encerrado`);
    }
    if (owner === "owned") await this.d.herdr.closeTab(t.tab_id);
    return this.update(taskId, (x) => {
      x.status = "cancelled";
      x.notified = true;
    });
  }

  /** Ao iniciar: atualiza as tarefas ativas a partir do disco e do Herdr. */
  async reconcile(): Promise<void> {
    await this.refreshAll();
  }
}
