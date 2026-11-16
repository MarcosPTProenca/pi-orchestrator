/**
 * Extensão do orquestrador (carregada só pelo launcher bin/pi-orch via `pi -e`).
 * Tools tipadas e um watcher por tarefa ativa. Os watchers não usam LLM: só avisam
 * quando há decisão, bloqueio ou conclusão.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrCli } from "./herdr.ts";
import { availableModels, resolveModel } from "./models.ts";
import { Orchestrator, MODES, type DelegateInput, type WatchEvent } from "./orchestrator.ts";
import { fixInputFor, listRedPrs } from "./prs.ts";
import { FixQueue } from "./queue.ts";
import { Store, defaultStateDir } from "./store.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Papel do orquestrador. Curto e positivo: o contrato detalhado fica nas tools e no intake. */
export const FIRST_MATE_ROLE = [
  "# Papel: orquestrador",
  "Você lança workers Pi para o usuário. Não executa o trabalho do projeto.",
  "Procedimento:",
  "1. Reúna: projeto (raiz do repositório), pedido literal, objetivo, modo, modelo e quantidade de workers.",
  "2. Lance com orch_delegate (com `tasks` para vários workers numa chamada) ou, para PRs vermelhas, com orch_fix_red_prs.",
  "3. Preserve o que o usuário pediu: quantidade, modelo, projeto, escopo e modo. Não substitua nada em silêncio.",
  "4. Pergunte só se faltar algo que impede o lançamento. Caso contrário, lance.",
  "5. Depois de lançar, diga o que foi lançado e encerre o turno. Não pesquise, não levante, não divida trabalho por iniciativa própria.",
  "Resultados e decisões chegam como mensagens: apresente-os sem narrar o mecanismo.",
].join("\n");

/** Mensagem ao usuário: resultado ou decisão, sem campos técnicos. */
export function formatEvent(e: WatchEvent): string {
  const ref = `[${e.task_id.slice(-6)}] ${e.project_id}`;
  switch (e.status) {
    case "done": {
      const lines = [`${ref}: concluído. ${e.result ?? ""}`.trim()];
      if (e.artifacts.length) lines.push(`Arquivos: ${e.artifacts.join(", ")}`);
      return lines.join("\n");
    }
    case "blocked":
      return `${ref} precisa de uma decisão: ${e.question ?? "(pergunta não informada)"}`;
    case "failed":
      return `${ref}: não concluiu. ${e.error ?? ""}`.trim();
    case "timeout":
      return `${ref}: passou do prazo e segue aberto. Quer que eu cancele?`;
    case "lost":
      return `${ref}: perdi o acompanhamento (${e.error ?? "motivo desconhecido"}).`;
    default:
      return `${ref}: ${e.status}`;
  }
}

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

const TERMINAL = new Set(["done", "failed", "timeout", "lost"]);

const DELEGATE_ITEM = {
  type: "object",
  properties: {
    project_path: { type: "string", description: "Raiz absoluta do repositório git (checkout principal, com .git)." },
    role: { type: "string", description: "Papel curto, ex.: fix-pr, investigate." },
    request: { type: "string", description: "Pedido do usuário, copiado literalmente." },
    objective: { type: "string", description: "Como saber que terminou: critério verificável." },
    mode: { type: "string", enum: [...MODES], description: "report: só relatório. direct-pr: implementa, dá push e abre/atualiza o PR. local-only: implementa sem push." },
    constraints: { type: "array", items: { type: "string" }, description: "Restrições do usuário, copiadas. Ex.: não tocar em outros arquivos." },
    source: { type: "string", description: "URL da PR ou issue, quando houver." },
    branch: { type: "string", description: "Branch de trabalho. Omitida: o worker descobre a da PR citada." },
    spec: { type: "string", description: "Especificação de construção, só quando o pedido precisa de passos próprios." },
    model: { type: "string", description: "Modelo exato, ex.: claude-bridge/claude-haiku-5-5. Se indisponível, a chamada falha." },
    timeout_minutes: { type: "number" },
  },
  required: ["project_path", "role", "request", "objective", "mode"],
  additionalProperties: false,
};

export default function orchestratorExtension(pi: ExtensionAPI): void {
  const stateDir = defaultStateDir();
  const dryRun = process.env.PI_ORCH_DRY_RUN === "1";
  const orch = new Orchestrator({
    herdr: new HerdrCli(),
    store: new Store(join(stateDir, "state.json")),
    tasksDir: join(stateDir, "tasks"),
    workerExtPath: process.env.PI_ORCH_WORKER_EXT ?? resolve(here, "worker-ext.ts"),
    now: () => Date.now(),
    newHex: () => randomBytes(4).toString("hex"),
    availableModels,
    dryRun,
  });

  const watchers = new Map<string, AbortController>();
  /** Fila de correções de PR: no máximo N workers em paralelo, avançando quando um termina. */
  let fixQueue: FixQueue<DelegateInput> | undefined;

  const startWatch = (taskId: string): void => {
    if (dryRun || watchers.has(taskId)) return;
    const ac = new AbortController();
    watchers.set(taskId, ac);
    orch
      .watch(taskId, ac.signal)
      .then((event) => {
        watchers.delete(taskId);
        if (event && TERMINAL.has(event.status)) void fixQueue?.settle(taskId);
        if (event && orch.takeNotice(taskId)) {
          pi.sendMessage(
            { customType: "orch-event", content: formatEvent(event), display: true, details: event },
            { triggerTurn: false },
          );
        }
      })
      .catch((err: unknown) => {
        watchers.delete(taskId);
        pi.sendMessage(
          { customType: "orch-event", content: `[orquestrador] watcher de ${taskId} falhou: ${String(err)}`, display: true },
          { triggerTurn: false },
        );
      });
  };

  const startTask = async (input: DelegateInput): Promise<string> => {
    const task = await orch.delegate(input);
    startWatch(task.task_id);
    return task.task_id;
  };

  pi.on("session_start", async () => {
    if (dryRun) return;
    await orch.reconcile();
    for (const t of orch.list()) {
      if (t.status === "running" || t.status === "starting") startWatch(t.task_id);
    }
  });

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(FIRST_MATE_ROLE)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${FIRST_MATE_ROLE}` };
  });

  pi.on("session_shutdown", () => {
    for (const ac of watchers.values()) ac.abort();
    watchers.clear();
  });

  pi.registerTool({
    name: "orch_delegate",
    label: "orch delegate",
    description:
      "Lança workers Pi com brief completo montado pelo intake. Para N workers, passe N itens em tasks numa única chamada. A chamada inteira é validada antes: se algum item for inválido, nada é lançado. Cada worker arrenda a própria worktree pelo treehouse.",
    parameters: {
      type: "object",
      properties: {
        tasks: { type: "array", minItems: 1, maxItems: 8, items: DELEGATE_ITEM, description: "Um item por worker. Copie o pedido do usuário, sem reescrever." },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { tasks: Array<Record<string, unknown>> }) {
      const inputs = params.tasks as unknown as DelegateInput[];
      for (const input of inputs) orch.checkDelegate(input);
      const started = [];
      // Sequencial de propósito: a criação do workspace do projeto não pode correr em paralelo.
      for (const input of inputs) {
        const task = await orch.delegate(input);
        startWatch(task.task_id);
        started.push({
          task_id: task.task_id,
          role: task.role,
          status: task.status,
          model: task.model,
          mode: input.mode,
          project: task.project_path,
          brief: task.brief_path,
        });
      }
      return asText({ started_count: started.length, dry_run: dryRun, started });
    },
  });

  pi.registerTool({
    name: "orch_fix_red_prs",
    label: "orch fix red prs",
    description:
      "Lista as PRs abertas com checks vermelhos de um repositório e lança um worker por PR (modo direct-pr), no máximo `concurrency` em paralelo. Avança a fila sozinho quando um worker termina. Use para pedidos de resolver PRs vermelhas.",
    parameters: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Raiz absoluta do checkout do repositório (com .git e remote origin)." },
        model: { type: "string", description: "Modelo exato dos workers. Se indisponível, nada é lançado." },
        concurrency: { type: "number", description: "Workers em paralelo, 1 a 4. Padrão 2." },
      },
      required: ["repo_path"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { repo_path: string; model?: string; concurrency?: number }) {
      resolveModel(params.model, availableModels());
      const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: params.repo_path, encoding: "utf8" }).trim();
      const prs = await listRedPrs(params.repo_path, remote);
      if (prs.length === 0) return asText({ red_prs: 0, message: "nenhuma PR aberta com check vermelho" });
      const concurrency = params.concurrency ?? 2;
      if (!fixQueue) fixQueue = new FixQueue<DelegateInput>(Math.min(Math.max(concurrency, 1), 4), startTask);
      const inputs = prs.map((pr) => fixInputFor(pr, params.repo_path, params.model));
      for (const input of inputs) orch.checkDelegate(input);
      await fixQueue.enqueue(inputs);
      return asText({
        red_prs: prs.map((pr) => ({ number: pr.number, title: pr.title, branch: pr.headRefName, failing: pr.failing })),
        running_task_ids: fixQueue.runningIds,
        queued: fixQueue.pendingCount,
        failed_to_start: fixQueue.failed.map((f) => ({ pr: f.item.role, error: f.error })),
      });
    },
  });

  pi.registerTool({
    name: "orch_status",
    label: "orch status",
    description: "Lista as tarefas e seus estados a partir do estado local. Não consome LLM nem consulta workers.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return asText(
        orch.list().map((t) => ({
          task_id: t.task_id,
          project_id: t.project_id,
          role: t.role,
          status: t.status,
          model: t.model,
          pane_id: t.pane_id,
          question: t.question,
          deadline_at: t.deadline_at,
        })),
      );
    },
  });

  pi.registerTool({
    name: "orch_inbox",
    label: "orch inbox",
    description: "Mostra decisões abertas (bloqueadas) e tarefas concluídas, falhas ou expiradas ainda não avisadas. Cada aviso terminal aparece uma vez.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return asText(orch.inbox());
    },
  });

  pi.registerTool({
    name: "orch_answer",
    label: "orch answer",
    description: "Envia a resposta do usuário a uma tarefa bloqueada. O worker recebe como nova mensagem e continua.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" }, answer: { type: "string" } },
      required: ["task_id", "answer"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { task_id: string; answer: string }) {
      const task = await orch.answer(params.task_id, params.answer);
      startWatch(task.task_id);
      return asText({ task_id: task.task_id, status: task.status });
    },
  });

  pi.registerTool({
    name: "orch_close",
    label: "orch close",
    description: "Fecha a tab de uma tarefa já concluída, falha ou expirada, depois que o usuário validou o resultado. Não apaga relatórios.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { task_id: string }) {
      const task = await orch.close(params.task_id);
      return asText({ task_id: task.task_id, status: task.status, tab_closed: true });
    },
  });

  pi.registerTool({
    name: "orch_cancel",
    label: "orch cancel",
    description: "Cancela uma tarefa ativa fechando somente a tab que o orquestrador criou. Não apaga relatórios.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { task_id: string }) {
      const task = await orch.cancel(params.task_id);
      watchers.get(params.task_id)?.abort();
      void fixQueue?.settle(params.task_id);
      return asText({ task_id: task.task_id, status: task.status });
    },
  });
}
