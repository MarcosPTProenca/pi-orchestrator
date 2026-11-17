/**
 * Núcleo do orquestrador: delegação, acompanhamento, respostas, cancelamento
 * e reconciliação. Não chama LLM. Recebe o Herdr e o estado por injeção.
 */
import { resolveModel } from "./models.ts";
import { workerAgentName } from "./label.ts";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { clampLines, maskSecrets } from "./logs.ts";
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
  /** Devolve a worktree da tarefa ao pool, se seguro, e devolve a nota para o usuário. */
  releaseWorktree?: (task: TaskRecord) => string;
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
  /** Enriquece a entrada com o estado atual da fonte (ex.: PR) no momento do lançamento. */
  enrichSource?: (input: DelegateInput) => Promise<DelegateInput>;
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

/** Mesmo trabalho: mesma PR (source) ou mesma branch no mesmo projeto. Devolve o rótulo do conflito, ou null. */
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
}

/** Aspas simples seguras para o shell do pane: o comando é digitado no shell do Herdr. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
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

  /** Quantas tarefas ocupam vaga agora (starting, running, blocked). */
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
    this.assertNotActive(input);
  }

  /** Valida um lote inteiro antes de lançar qualquer item: recusa também duplicado dentro do próprio lote. */
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

  /** Tarefa ativa no mesmo projeto para a mesma PR ou branch, ou null. Não lança. */
  activeConflict(input: DelegateInput): { task: TaskRecord; label: string } | null {
    const projectId = basename(input.project_path);
    for (const t of this.list()) {
      if (!isActive(t.status) || t.project_id !== projectId) continue;
      const dup = sameWork({ ...input, source: t.source ?? undefined, branch: t.branch ?? undefined, project_path: t.project_path }, input);
      if (dup) return { task: t, label: dup };
    }
    return null;
  }

  /** Recusa lançar se já existe tarefa ativa para a mesma PR ou branch no mesmo projeto. */
  private assertNotActive(input: DelegateInput): void {
    const c = this.activeConflict(input);
    if (c) throw new Error(`já existe a tarefa ${c.task.task_id} ativa para a mesma ${c.label} (${c.task.status}); aguarde ou cancele antes de lançar outra`);
  }

  async delegate(rawInput: DelegateInput): Promise<TaskRecord> {
    // Estado da fonte lido agora, não na listagem de minutos atrás.
    const input = this.d.enrichSource ? await this.d.enrichSource(rawInput) : rawInput;
    this.assertNotActive(input);
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
      source: input.source?.trim() || null,
      branch: input.branch?.trim() || null,
      model: model ?? null,
      mode: input.mode,
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
      // Assíncrono, como o FirstMate: digita o comando no pane e segue. O Herdr reconhece o agente depois,
      // e o webhook do worker é quem avisa o fim. Não há espera bloqueante pelo agente subir.
      await this.d.herdr.runInPane(tab.pane_id, ["pi", ...piArgs].map(shellQuote).join(" "));
      await this.d.herdr.renamePane(tab.pane_id, workerId).catch(() => undefined);
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
    this.syncUsage(taskId);
    const t = this.get(taskId);
    // Relatório novo vale em qualquer estado, menos cancelled (decisão do usuário): um worker que falhou por erro
    // transitório do modelo e seguiu depois não pode ficar preso em failed/timeout/lost.
    if (t.status !== "cancelled" && t.status !== "planned" && this.collect(taskId)) return this.toEvent(this.get(taskId));
    if (!isActive(t.status) || t.status === "blocked") return null;
    if (t.deadline_at !== null && this.d.now() >= Date.parse(t.deadline_at)) {
      return this.setTerminal(taskId, "timeout", `prazo definido por você (${t.deadline_at}) foi atingido; o worker segue rodando`);
    }
    const owner = await this.ownership(t);
    if (owner !== "owned") {
      this.noteWorktree(taskId);
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
      if (t.status !== "cancelled") await this.refresh(t.task_id).catch(() => null);
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

  /** Grava o resultado da verificação da conclusão. Não muda o relatório nem o status. */
  setVerification(taskId: string, v: { verdict: "approved" | "rejected" | "not_applicable" | "unverified"; reason: string }): void {
    this.update(taskId, (x) => {
      x.verification = v;
    });
  }

  /** Copia o uso de tokens que o worker gravou em usage.json para o registro (sem LLM, sem efeito se ausente). */
  private syncUsage(taskId: string): void {
    const file = join(this.get(taskId).task_dir, "usage.json");
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { total?: Record<string, number> };
      const u = parsed.total;
      if (!u || typeof u.totalTokens !== "number") return;
      const next = { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, totalTokens: u.totalTokens };
      const cur = this.get(taskId).usage;
      if (cur && JSON.stringify(cur) === JSON.stringify(next)) return;
      this.update(taskId, (x) => {
        x.usage = next;
      });
    } catch {
      // usage.json ilegível não derruba a atualização da tarefa.
    }
  }

  /** Reabre o aviso de uma tarefa: volta a ser pendente (usado quando o envio ao orquestrador falha). */
  reopenNotice(taskId: string): void {
    this.update(taskId, (x) => {
      x.notified = false;
    });
  }

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

  /** Aviso pendente desta tarefa (decisão ou terminal ainda não entregue). Devolve o evento e o marca como entregue. */
  private takePending(taskId: string): WatchEvent | null {
    const t = this.get(taskId);
    const pending = !t.notified && (t.status === "blocked" || (!isActive(t.status) && t.status !== "cancelled" && t.status !== "planned"));
    if (!pending) return null;
    this.takeNotice(taskId);
    return this.toEvent(t);
  }

  /** Atualiza a tarefa e entrega o aviso pendente, se houver, uma única vez (webhook e varredura usam isto). */
  async noticeFor(taskId: string): Promise<WatchEvent | null> {
    await this.refresh(taskId).catch(() => null);
    return this.takePending(taskId);
  }

  /** Varre todas as tarefas (menos canceladas) e devolve os avisos novos. Sem LLM: só disco e Herdr. */
  async sweep(): Promise<WatchEvent[]> {
    const out: WatchEvent[] = [];
    for (const t of this.list()) {
      if (t.status === "cancelled") continue;
      const ev = await this.noticeFor(t.task_id);
      if (ev) out.push(ev);
    }
    return out;
  }

  /**
   * Avisos que ainda não foram entregues: decisões (blocked) e terminais. Ao devolver, marca como entregues.
   * Usado ao abrir a sessão, para não reanunciar bloqueios que já foram avisados.
   */
  async pendingNotices(): Promise<WatchEvent[]> {
    return this.sweep();
  }

  /** Últimas linhas do painel da tarefa. Só lê se o painel ainda for da tarefa; não altera estado. */
  async logs(taskId: string, lines?: number): Promise<string> {
    const t = this.get(taskId);
    const owner = await this.ownership(t);
    if (owner === "missing") throw new Error("o painel da tarefa não existe mais; nada foi lido");
    if (owner === "mismatch") throw new Error("o painel trocou de agente; nada foi lido");
    return maskSecrets(await this.d.herdr.readRecent(t.pane_id, clampLines(lines)));
  }

  /**
   * Mensagem a um worker em execução. Não interrompe: o Pi entrega como próximo turno, depois do turno
   * atual (medido com herdr agent prompt em worker ocupado). Bloqueado: vira resposta, como orch_answer.
   */
  async send(taskId: string, text: string): Promise<TaskRecord> {
    const t = this.get(taskId);
    if (t.status !== "running" && t.status !== "blocked") throw new Error(`tarefa ${taskId} não aceita mensagem (status: ${t.status})`);
    if (text.trim() === "") throw new Error("mensagem vazia");
    // Mesma checagem de dono para os dois estados, antes de qualquer envio.
    const owner = await this.ownership(t);
    if (owner === "missing") throw new Error("o painel da tarefa não existe mais; nada foi enviado");
    if (owner === "mismatch") throw new Error("o painel trocou de agente; nada foi enviado");
    if (t.status === "blocked") return this.answer(taskId, text);
    await this.d.herdr.prompt(t.pane_id, text);
    return t;
  }

  async answer(taskId: string, text: string): Promise<TaskRecord> {
    const t = this.get(taskId);
    if (t.status !== "blocked") throw new Error(`tarefa ${taskId} não está bloqueada (status: ${t.status})`);
    if (text.trim() === "") throw new Error("resposta vazia");
    // Fala com o worker pelo pane: o nome do agente só existe depois que o Herdr o reconhece.
    await this.d.herdr.prompt(t.pane_id, text);
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
    this.update(taskId, (x) => {
      x.status = "cancelled";
      x.notified = true;
    });
    this.noteWorktree(taskId);
    return this.get(taskId);
  }

  /** Tenta devolver a worktree da tarefa e grava a nota. Nunca lança. */
  private noteWorktree(taskId: string): void {
    const t = this.get(taskId);
    let note: string | null = null;
    try {
      note = this.d.releaseWorktree?.(t) ?? null;
    } catch (err) {
      note = `falha ao devolver a worktree: ${String(err).slice(0, 160)}`;
    }
    if (note !== null) this.update(taskId, (x) => { x.worktree_note = note; });
  }

  /** Ao iniciar: atualiza as tarefas ativas a partir do disco e do Herdr. */
  async reconcile(): Promise<void> {
    await this.refreshAll();
  }
}
