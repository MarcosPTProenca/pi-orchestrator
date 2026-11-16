/**
 * Núcleo do orquestrador: delegação, acompanhamento, respostas, cancelamento
 * e reconciliação. Não chama LLM. Recebe o Herdr e o estado por injeção.
 */
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
}

export const MODES = ["report", "direct-pr", "local-only"] as const;
export type Mode = (typeof MODES)[number];

export interface DelegateInput {
  /** Raiz de um repositório git (checkout principal). O worker arrenda a própria worktree a partir dele. */
  project_path: string;
  role: string;
  /** Pedido do usuário, com o contexto necessário para lê-lo (ex.: a PR ou issue e o que ela diz). */
  intent: string;
  /** Especificação de construção escrita pelo orquestrador: o que fazer, em que ordem e como validar. */
  spec: string;
  /** report: só relatório. direct-pr: implementa, dá push na branch e abre/atualiza o PR. local-only: implementa sem push. */
  mode: Mode;
  /** Branch em que o worker trabalha. Omitida: o worker descobre a branch da PR citada no pedido. */
  branch?: string;
  timeout_minutes?: number;
  /** Modelo do worker, ex.: claude-bridge/claude-haiku-5-5. Omitido = padrão do Pi. */
  model?: string;
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

const WAIT_CHUNK_MS = 60_000;
/** Teto para o worker começar a trabalhar após o prompt. Evita ler `idle` anterior ao início. */
const START_WAIT_MS = 20_000;
const RETRY_MS = 5_000;
const DEFAULT_TIMEOUT_MIN = 30;
const MAX_PROMPT_ATTEMPTS = 2;
const DIAG_LINES = 30;

const DOD: Record<Mode, (branch: string) => string[]> = {
  report: () => [
    "Investigue e escreva o relatório em `result`: o que você fez, o que encontrou, evidências (comandos e saídas, arquivo:linha) e o que recomenda.",
    "Não faça push nem abra PR. Não altere o remoto.",
  ],
  "direct-pr": (branch) => [
    "Implemente o que a especificação pede, seguindo a skill `implement`: entender, implementar, testar, revisar.",
    branch
      ? `Faça commit na branch \`${branch}\`, dê push e abra o PR (ou atualize o existente) com gh.`
      : "Faça commit na branch de trabalho, dê push e abra o PR (ou atualize o existente da PR citada) com gh.",
    "Verifique os checks do PR. Se a falha for do seu código, corrija e rode de novo até ficarem verdes.",
    "Ao final, coloque em `artifacts` a URL completa do PR.",
  ],
  "local-only": (branch) => [
    "Implemente o que a especificação pede, com testes, seguindo a skill `implement`.",
    branch
      ? `Faça commit na branch \`${branch}\`. Não faça push nem abra PR.`
      : "Faça commit na branch de trabalho. Não faça push nem abra PR.",
  ],
};

export function buildBrief(taskId: string, reportPath: string, input: DelegateInput): string {
  const dod = DOD[input.mode](input.branch ?? "").map((l) => `- ${l}`);
  return [
    `# Tarefa ${taskId} (papel: ${input.role}, modo: ${input.mode})`,
    "",
    "Você é um worker: uma unidade autônoma gerenciada pelo orquestrador. Trabalhe sem esperar um humano.",
    "",
    "## Pedido do usuário",
    input.intent.trim(),
    "",
    "## Especificação de construção",
    input.spec.trim(),
    "",
    "## Setup",
    `1. Arrende sua worktree isolada a partir do repositório ${input.project_path}: \`treehouse get --lease --lease-holder ${taskId}\`. O comando imprime o caminho; entre nele.`,
    `2. Verifique o isolamento com \`pwd -P\` e \`git rev-parse --show-toplevel\`. Os dois devem apontar para a sua worktree, não para ${input.project_path}. Se não baterem, chame orch_report com status failed e pare.`,
    input.branch
      ? `3. Faça checkout da branch \`${input.branch}\` na sua worktree antes de editar.`
      : "3. Se o pedido cita uma PR, descubra a branch dela (`gh pr view <número> --json headRefName`) e faça checkout. Sem PR, crie uma branch nova a partir da base.",
    "",
    "## Regras",
    "1. Só faça push ou abra PR conforme o modo acima. Nunca no checkout principal.",
    "2. Use gh autenticado com a conta certa, conforme as skills de credenciais. Nunca consulte a API sem autenticação.",
    "3. Você não fala com o usuário. Decisão de produto ou ação destrutiva: chame orch_report com status blocked e question, e encerre o turno.",
    "4. Obstáculo que se repete duas vezes: orch_report com status blocked e o motivo.",
    "5. Não reporte progresso. Chame orch_report uma vez, no fim.",
    "",
    "## Definição de pronto",
    ...dod,
    "",
    "## Relatório final",
    `Chame orch_report com status (done, failed ou blocked), result (standalone, com evidências) e artifacts (URLs, caminhos). O relatório fica em ${reportPath}.`,
    "",
  ].filter((l) => l !== undefined).join("\n");
}

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

  async delegate(input: DelegateInput): Promise<TaskRecord> {
    if (!isAbsolute(input.project_path) || !isDirectory(input.project_path)) {
      throw new Error(`project_path precisa ser um diretório absoluto existente: ${input.project_path}`);
    }
    if (!existsSync(join(input.project_path, ".git"))) {
      throw new Error(`project_path não é a raiz de um repositório git: ${input.project_path}. Informe o checkout do projeto, não um diretório pai.`);
    }
    for (const [field, value] of [["intent", input.intent], ["spec", input.spec], ["role", input.role]] as const) {
      if (!value || value.trim() === "") throw new Error(`${field} vazio`);
      if (/\{[A-Z_]+\}/.test(value)) throw new Error(`${field} ainda tem placeholder: ${value.match(/\{[A-Z_]+\}/)?.[0]}`);
    }
    if (!(MODES as readonly string[]).includes(input.mode)) throw new Error(`mode inválido: ${String(input.mode)} (use ${MODES.join(", ")})`);

    const projectId = basename(input.project_path);
    const taskId = `t-${this.d.newHex()}`;
    const workerId = `orch-${this.d.newHex().slice(0, 8)}`;
    const taskDir = join(this.d.tasksDir, taskId);
    mkdirSync(taskDir, { recursive: true });
    const briefPath = join(taskDir, "brief.md");
    const reportPath = join(taskDir, "report.json");

    writeFileSync(briefPath, buildBrief(taskId, reportPath, input));

    const timeoutMin = input.timeout_minutes ?? DEFAULT_TIMEOUT_MIN;
    const now = this.iso();
    const record: TaskRecord = {
      task_id: taskId,
      project_id: projectId,
      project_path: input.project_path,
      model: input.model ?? null,
      role: input.role,
      worker_id: workerId,
      workspace_id: "",
      tab_id: "",
      pane_id: "",
      terminal_id: "",
      status: "starting",
      task_dir: taskDir,
      brief_path: briefPath,
      created_at: now,
      updated_at: now,
      deadline_at: this.iso(this.d.now() + timeoutMin * 60_000),
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

    let tabId: string | undefined;
    try {
      const ws = await this.ensureWorkspace(input.project_path, projectId);
      const tab = await this.d.herdr.createTab({
        workspaceId: ws.workspace_id,
        cwd: input.project_path,
        label: `${input.role}-${taskId.slice(-6)}`,
        env: { PI_ORCH_ROLE: "worker", PI_ORCH_TASK_ID: taskId, PI_ORCH_TASK_DIR: taskDir },
      });
      tabId = tab.tab_id;
      this.update(taskId, (t) => {
        t.workspace_id = ws.workspace_id;
        t.tab_id = tab.tab_id;
        t.pane_id = tab.pane_id;
        t.terminal_id = tab.terminal_id;
      });
      const piArgs = ["-e", this.d.workerExtPath];
      if (input.model) piArgs.push("--model", input.model);
      await this.d.herdr.startAgent({ name: workerId, paneId: tab.pane_id, piArgs, timeoutMs: 60_000 });
      await this.d.herdr.prompt(workerId, this.startPrompt(briefPath));
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
    return this.toEvent(
      this.update(taskId, (x) => {
        x.status = status;
        x.error = error;
        x.notified = false;
      }),
    );
  }

  /**
   * Espera o término da execução (ou um bloqueio) sem consumir LLM.
   * Usa `herdr agent wait` em blocos e devolve um evento quando o estado muda.
   * Devolve null se o sinal de cancelamento do watcher disparar.
   */
  async watch(taskId: string, signal: AbortSignal): Promise<WatchEvent | null> {
    return this.watchLoop(taskId, signal);
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

  private startPrompt(briefPath: string): string {
    return `Leia o arquivo ${briefPath} e execute a tarefa. Ao terminar, chame orch_report.`;
  }

  private async watchLoop(taskId: string, signal: AbortSignal): Promise<WatchEvent | null> {
    let awaitingStart = true;
    for (;;) {
      if (signal.aborted) return null;
      const t = this.get(taskId);
      if (t.status !== "running" && t.status !== "starting") return this.toEvent(t);

      if (this.collect(taskId)) return this.toEvent(this.get(taskId));

      const remaining = Date.parse(t.deadline_at) - this.d.now();
      if (remaining <= 0) {
        return this.setTerminal(taskId, "timeout", "prazo excedido; o worker não foi encerrado");
      }

      let outcome: { reached: string } | { timeout: true };
      try {
        if (awaitingStart) {
          awaitingStart = false;
          const started = await this.d.herdr.waitAgent(t.worker_id, ["working"], Math.min(START_WAIT_MS, remaining), signal);
          if ("reached" in started) {
            this.update(taskId, (x) => {
              x.worker_started = true;
            });
          }
          if (signal.aborted) return null;
          if (this.collect(taskId)) return this.toEvent(this.get(taskId));
        }
        outcome = await this.d.herdr.waitAgent(
          t.worker_id,
          ["idle", "done", "blocked"],
          Math.min(WAIT_CHUNK_MS, remaining),
          signal,
        );
      } catch (err) {
        if (signal.aborted) return null;
        if (this.collect(taskId)) return this.toEvent(this.get(taskId));
        const owner = await this.ownership(t);
        if (owner !== "owned") {
          return this.setTerminal(taskId, "lost", `pane ${owner === "missing" ? "sumiu" : "trocou de agente"}: ${errorMessage(err)}`);
        }
        await sleep(RETRY_MS, signal);
        continue;
      }

      if (signal.aborted) return null;
      if (this.collect(taskId)) return this.toEvent(this.get(taskId));
      if (!("reached" in outcome)) continue;

      if (outcome.reached === "blocked") {
        return this.toEvent(
          this.update(taskId, (x) => {
            x.status = "blocked";
            x.question = "O agente parou em um prompt de aprovação ou pergunta sem relatório. Verifique o pane.";
            x.notified = false;
          }),
        );
      }
      const current = this.get(taskId);
      if (current.prompt_attempts < MAX_PROMPT_ATTEMPTS) {
        // Ocioso sem relatório: o brief pode não ter sido consumido ou o worker parou no meio. Reenvia com lembrete.
        const reminder = `${this.startPrompt(current.brief_path)} Você ainda não chamou orch_report. Execute o brief agora e encerre com orch_report.`;
        await this.d.herdr.prompt(current.worker_id, reminder);
        this.update(taskId, (x) => {
          x.prompt_attempts += 1;
        });
        awaitingStart = true;
        continue;
      }
      const tail = await this.d.herdr.readRecent(current.worker_id, DIAG_LINES).catch(() => "");
      const lastLines = tail.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(-4).join(" | ");
      return this.setTerminal(
        taskId,
        "failed",
        `worker ficou ocioso sem chamar orch_report após ${current.prompt_attempts} envios.${lastLines ? ` Última saída do worker: ${lastLines}` : ""}`,
      );
    }
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

  /** Decisões abertas (blocked) e terminais ainda não avisados. Marca os terminais como avisados. */
  inbox(): WatchEvent[] {
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

  /** Ao iniciar: reconcilia tarefas ativas com os panes vivos e os relatórios em disco. */
  async reconcile(): Promise<void> {
    for (const t of this.list()) {
      if (!isActive(t.status)) continue;
      if (this.collect(t.task_id)) continue;
      const owner = await this.ownership(t);
      if (owner !== "owned") {
        this.setTerminal(t.task_id, "lost", `pane ${owner === "missing" ? "não existe mais" : "trocou de agente"} ao reconciliar`);
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
