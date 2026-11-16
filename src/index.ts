/**
 * Extensão do orquestrador (carregada só pelo launcher bin/pi-orch via `pi -e`).
 * Expõe 5 tools tipadas e um watcher por tarefa ativa. Os watchers não usam LLM:
 * só disparam uma mensagem quando há decisão, bloqueio ou conclusão.
 */
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrCli } from "./herdr.ts";
import { Orchestrator, type WatchEvent } from "./orchestrator.ts";
import { Store, defaultStateDir } from "./store.ts";

const here = dirname(fileURLToPath(import.meta.url));

function formatEvent(e: WatchEvent): string {
  const head = `[orquestrador] ${e.project_id} (${e.task_id}): ${e.status}`;
  const lines = [head];
  if (e.status === "blocked") lines.push(`Decisão necessária: ${e.question ?? "(sem pergunta)"}`, `Responda com orch_answer(task_id="${e.task_id}", answer=...).`);
  if (e.result) lines.push(`Resultado: ${e.result}`);
  if (e.artifacts.length) lines.push(`Artefatos: ${e.artifacts.join(", ")}`);
  if (e.error) lines.push(`Erro: ${e.error}`);
  return lines.join("\n");
}

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

export default function orchestratorExtension(pi: ExtensionAPI): void {
  const stateDir = defaultStateDir();
  const orch = new Orchestrator({
    herdr: new HerdrCli(),
    store: new Store(join(stateDir, "state.json")),
    tasksDir: join(stateDir, "tasks"),
    workerExtPath: process.env.PI_ORCH_WORKER_EXT ?? resolve(here, "worker-ext.ts"),
    now: () => Date.now(),
    newHex: () => randomBytes(4).toString("hex"),
  });

  const watchers = new Map<string, AbortController>();

  const startWatch = (taskId: string): void => {
    if (watchers.has(taskId)) return;
    const ac = new AbortController();
    watchers.set(taskId, ac);
    orch
      .watch(taskId, ac.signal)
      .then((event) => {
        watchers.delete(taskId);
        if (event && orch.takeNotice(taskId)) {
          pi.sendMessage(
            { customType: "orch-event", content: formatEvent(event), display: true, details: event },
            { triggerTurn: true },
          );
        }
      })
      .catch((err: unknown) => {
        watchers.delete(taskId);
        pi.sendMessage(
          { customType: "orch-event", content: `[orquestrador] watcher de ${taskId} falhou: ${String(err)}`, display: true },
          { triggerTurn: true },
        );
      });
  };

  pi.on("session_start", async () => {
    await orch.reconcile();
    for (const t of orch.list()) {
      if (t.status === "running" || t.status === "starting") startWatch(t.task_id);
    }
  });

  pi.on("session_shutdown", () => {
    for (const ac of watchers.values()) ac.abort();
    watchers.clear();
  });

  pi.registerTool({
    name: "orch_delegate",
    label: "orch delegate",
    description:
      "Cria um pane Herdr com uma sessão Pi independente em project_path e entrega o brief. Retorna a tarefa. Um watcher avisa quando houver decisão, bloqueio ou conclusão.",
    parameters: {
      type: "object",
      properties: {
        project_path: { type: "string", description: "Diretório absoluto do projeto (ou worktree)." },
        role: { type: "string", description: "Papel curto, ex.: investigate, review." },
        brief: { type: "string", description: "Brief autocontido: objetivo, escopo, critérios de conclusão." },
        timeout_minutes: { type: "number", description: "Prazo; ao expirar, marca timeout sem encerrar o pane." },
      },
      required: ["project_path", "role", "brief"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { project_path: string; role: string; brief: string; timeout_minutes?: number }) {
      const task = await orch.delegate(params);
      startWatch(task.task_id);
      return asText({ task_id: task.task_id, worker_id: task.worker_id, pane_id: task.pane_id, status: task.status });
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
    description:
      "Mostra decisões abertas (bloqueadas) e tarefas concluídas, falhas ou expiradas ainda não avisadas. Cada aviso terminal aparece uma vez.",
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
      properties: {
        task_id: { type: "string" },
        answer: { type: "string" },
      },
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
    name: "orch_cancel",
    label: "orch cancel",
    description:
      "Cancela uma tarefa ativa fechando somente o pane que o orquestrador criou. Não apaga relatórios nem worktrees.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { task_id: string }) {
      const task = await orch.cancel(params.task_id);
      watchers.get(params.task_id)?.abort();
      return asText({ task_id: task.task_id, status: task.status });
    },
  });
}
