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
import { Orchestrator, type DelegateInput, type WatchEvent } from "./orchestrator.ts";
import { Store, defaultStateDir } from "./store.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Papel do orquestrador (first mate). Acrescentado ao prompt do sistema a cada turno. */
export const FIRST_MATE_ROLE = [
  "# Papel: orquestrador",
  "Você coordena workers. Não executa trabalho de projeto.",
  "- Qualquer análise, leitura profunda, comando, edição ou pesquisa vai para um worker via orch_delegate.",
  "- Você só lê o suficiente para escrever um brief claro (read, grep, find, ls).",
  "- O brief é autocontido: objetivo, escopo, o que não fazer e o formato do relatório final.",
  "- Fale com o usuário em resultados e decisões. Não narre progresso nem mecanismo.",
  "- Quando um worker pedir decisão, apresente a pergunta ao usuário e use orch_answer com a resposta dele.",
  "- project_path é a raiz do repositório (checkout principal, com .git). Se o usuário nomear um repositório, localize-o (ex.: ~/github/<nome>) e confira antes de delegar. Nunca delegue em diretório pai.",
  "- Você não cria worktree. O worker arrenda a própria pelo treehouse ao iniciar, conforme as instruções dele.",
  "- Se o usuário pedir lotes (ex.: 2 a 2), delegue só o lote atual e espere os avisos dele antes do próximo.",
  "- Quando o usuário pedir um modelo, passe-o em model (ex.: claude-bridge/claude-haiku-5-5).",
  "- Pedido de PR ou issue é trabalho direto: um worker vê a PR ou a issue e resolve do início ao fim (entender, corrigir, testar, dar push). Não separe em etapas de levantamento, implementação e revisão, a menos que eu peça.",
  "- Você não fecha worker sozinho. Um worker concluído fica aberto até você validar o resultado; depois use orch_close.",
  "- Quando eu pedir N workers em paralelo (ex.: 2 a 2), lance os N numa única chamada orch_delegate com tasks. Nunca lance um por vez.",
  "- Cada worker recebe um brief completo, como um crewmate do FirstMate: intent (o pedido com o contexto) e spec (a especificação de construção que você escreve). Escreva a spec inteira; não delegue um resumo de uma linha.",
  "- Mode: use direct-pr quando o pedido é resolver uma PR ou issue (implementar, testar, dar push e atualizar o PR). Use report só para pedido de análise.",
  "- Para resolver uma lista de PRs ou issues com N workers: divida a lista em N partes. Cada worker resolve as PRs da sua parte, uma por vez, do início ao fim. Não existe etapa de levantamento separada.",
  "- Depois de delegar, diga em uma frase o que foi delegado e encerre o turno.",
  "- Não consulte status nem espere com bg_wait. O aviso chega sozinho quando houver resultado, decisão ou falha.",
  "- Não repita avisos já dados. Use orch_status ou orch_inbox só quando o usuário pedir.",
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

  pi.on("session_start", async () => {
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
      "Lança workers Pi independentes, cada um com brief completo (intent e spec), numa única chamada. Para N workers em paralelo, passe N itens em tasks. Cada worker arrenda a própria worktree pelo treehouse. Um watcher avisa quando houver decisão, bloqueio ou conclusão.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          description: "Um item por worker. Lance todos juntos; não chame orch_delegate uma vez por worker.",
          items: {
            type: "object",
            properties: {
              project_path: { type: "string", description: "Raiz absoluta de um repositório git." },
              role: { type: "string", description: "Papel curto, ex.: fix-pr, investigate." },
              intent: { type: "string", description: "Pedido do usuário com o contexto para lê-lo: PR ou issue, número, o que ela diz. Copie a substância, não resuma." },
              spec: { type: "string", description: "Especificação de construção escrita por você: o que fazer, em que ordem, como validar, o que não tocar." },
              mode: { type: "string", enum: ["report", "direct-pr", "local-only"], description: "report: só relatório. direct-pr: implementa, dá push na branch e abre ou atualiza o PR. local-only: implementa sem push." },
              branch: { type: "string", description: "Branch existente (ex.: head da PR) para direct-pr que atualiza uma PR. Obrigatória em direct-pr." },
              timeout_minutes: { type: "number" },
              model: { type: "string" },
            },
            required: ["project_path", "role", "intent", "spec", "mode"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { tasks: Array<Record<string, unknown>> }) {
      const started = [];
      // Sequencial de propósito: a criação do workspace do projeto não pode correr em paralelo.
      for (const raw of params.tasks) {
        const input = raw as unknown as DelegateInput;
        const task = await orch.delegate(input);
        startWatch(task.task_id);
        started.push({ task_id: task.task_id, role: task.role, worker_id: task.worker_id, pane_id: task.pane_id, status: task.status });
      }
      return asText({ started_count: started.length, started });
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
    name: "orch_close",
    label: "orch close",
    description:
      "Fecha a tab de uma tarefa já concluída, falha ou expirada, depois que você validou o resultado. Não apaga relatórios.",
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
