/**
 * Extensão do orquestrador (carregada só pelo launcher bin/pi-orch via `pi -e`).
 * Tools tipadas e um watcher por tarefa ativa. Os watchers não usam LLM: só avisam
 * quando há decisão, bloqueio ou conclusão.
 */
import { execFileSync } from "node:child_process";
import { startHook as startHook0, type HookHandle } from "./hook.ts";
import { DEFAULT_PRIORITY, pickModel, checkRequestedQuota, readQuota, type ProviderQuota } from "./quota.ts";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrCli } from "./herdr.ts";
import { availableModels, resolveModel } from "./models.ts";
import { Orchestrator, MODES, type DelegateInput, type WatchEvent } from "./orchestrator.ts";
import { fixInputFor, listRedPrs, prFromUrl, fetchPrState, verificationLine, prStateLine } from "./prs.ts";
import { FixQueue } from "./queue.ts";
import { locateProject } from "./locate.ts";
import { orchestratorAgentName } from "./label.ts";
import { execFile } from "node:child_process";
import { Store, defaultStateDir } from "./store.ts";
import { NoticeBatcher } from "./notices.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Papel do orquestrador. Curto e positivo: o contrato detalhado fica nas tools e no intake. */
export const FIRST_MATE_ROLE = [
  "# Papel: orquestrador",
  "Você lança workers Pi para o usuário. Não executa o trabalho do projeto.",
  "Procedimento:",
  "1. Reúna: projeto (raiz do repositório), pedido literal, objetivo, modo, modelo e quantidade de workers. Se o usuário citar um projeto pelo nome e você não tiver o caminho, use orch_locate_project antes de perguntar.",
  "2. Lance com orch_delegate (com `tasks` para vários workers numa chamada) ou, para PRs vermelhas, com orch_fix_red_prs.",
  "3. Preserve o que o usuário pediu: quantidade, modelo, projeto, escopo e modo. Não substitua nada em silêncio.",
  "4. Pergunte só se faltar algo que impede o lançamento, ou quando um worker reportar uma decisão nova. Caso contrário, lance.",
  "Nunca recomende nem proponha como opção uma ação pública (push, commit, PR, comentário, merge, fechamento de issue ou PR) que o usuário não pediu. Se um worker sugerir uma, apresente como sugestão do worker, sem recomendação, e espere o usuário decidir.",
  "5. Depois de lançar, diga o que foi lançado e encerre o turno. Não pesquise, não levante, não divida trabalho por iniciativa própria.",
  "Resultados e decisões chegam como mensagens: apresente-os sem narrar o mecanismo.",
].join("\n");

/**
 * Mensagem para o orquestrador (não para o terminal). O modelo lê o evento e responde ao usuário
 * em poucas linhas. O texto bruto do worker é truncado: o relatório completo fica no arquivo.
 */
export function modelMessageFor(e: WatchEvent): string {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} [truncado; relatório completo no arquivo do worker]` : text);
  const lines = [
    `[evento de worker] tarefa ${e.task_id} (${e.project_id}): ${e.status}`,
  ];
  if (e.result) lines.push(`Resumo do worker: ${clip(e.result, 1200)}`);
  if (e.question) lines.push(`Pergunta do worker: ${clip(e.question, 600)}`);
  if (e.artifacts.length) lines.push(`Artefatos: ${e.artifacts.join(", ")}`);
  if (e.error) lines.push(`Erro: ${clip(e.error, 400)}`);
  lines.push(
    "",
    "Responda ao usuário em até 5 linhas: o que aconteceu, o que ficou pronto e o que falta validar. Cite URLs de PR quando houver. Não cole o relatório do worker, e não narre o mecanismo.",
    "Se houver uma linha de verificação, ela vale mais que o relatório do worker: se disser NÃO VERIFICADA, não diga que a tarefa está concluída; diga o que falta.",
  );
  return lines.join("\n");
}

/** Mensagem exibida no terminal: só para o caso de o turno não ser possível. */
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
      return `${ref}: o prazo que você definiu foi atingido e o worker segue rodando. Quer que eu cancele?`;
    case "lost":
      return `${ref}: perdi o acompanhamento (${e.error ?? "motivo desconhecido"}).`;
    default:
      return `${ref}: ${e.status}`;
  }
}

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

/** Horário de Brasília (America/Sao_Paulo) para exibir ao usuário. Armazenamento continua em UTC. */
export function formatBrasilia(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "medium" }).format(new Date(iso));
}

const TERMINAL = new Set(["done", "failed", "timeout", "lost"]);

const DELEGATE_ITEM = {
  type: "object",
  properties: {
    project_path: { type: "string", description: "Raiz absoluta do repositório git (checkout principal, com .git)." },
    role: { type: "string", description: "Papel curto, ex.: fix-pr, investigate." },
    request: { type: "string", description: "O trabalho que o worker deve fazer, em palavras do usuário. Sem as instruções de lançamento: quantidade, modelo, projeto e modo ficam nos campos próprios." },
    objective: { type: "string", description: "Como saber que terminou: critério verificável." },
    mode: { type: "string", enum: [...MODES], description: "report: só relatório. direct-pr: implementa, dá push e abre/atualiza o PR. local-only: implementa sem push." },
    constraints: { type: "array", items: { type: "string" }, description: "Restrições do usuário, copiadas. Ex.: não tocar em outros arquivos." },
    source: { type: "string", description: "URL da PR ou issue, quando houver." },
    branch: { type: "string", description: "Branch de trabalho. Omitida: o worker descobre a da PR citada." },
    spec: { type: "string", description: "Especificação de construção, só quando o pedido precisa de passos próprios." },
    model: { type: "string", description: "Modelo exato, ex.: claude-bridge/claude-haiku-5-5. Pedido explícito: se indisponível ou sem cota, a chamada falha. Omitido: escolha automática pela cota (haiku 5.5, luna 6, kiro/auto por último)." },
    tracker: { type: "string", enum: ["github", "plane", "none"], description: "Onde ficam as issues deste projeto, descoberto pelo contexto (GitHub issues ou Plane)." },
    timeout_minutes: { type: "number", description: "Prazo explícito pedido pelo usuário, em minutos. Omitir = sem prazo." },
  },
  required: ["project_path", "role", "request", "objective", "mode"],
  additionalProperties: false,
};

export default function orchestratorExtension(pi: ExtensionAPI): void {
  const stateDir = defaultStateDir();
  const dryRun = process.env.PI_ORCH_DRY_RUN === "1";
  let quotaCache: { at: number; quotas: ProviderQuota[] } | undefined;

  /** Cota com cache de 60 s, para não chamar o quota-axi a cada item de um lote. */
  const quotas = async (): Promise<ProviderQuota[]> => {
    if (quotaCache && Date.now() - quotaCache.at < 60_000) return quotaCache.quotas;
    const fresh = await readQuota();
    quotaCache = { at: Date.now(), quotas: fresh };
    return fresh;
  };

  /** Modelo antes do lançamento. Pedido explícito: valida existência e cota, sem trocar. Sem pedido: ordem por cota. */
  const chooseModel = async (requested: string | undefined): Promise<{ model: string | undefined; reason: string }> => {
    const avail = availableModels();
    if (requested !== undefined && requested.trim() !== "") {
      const model = resolveModel(requested, avail);
      checkRequestedQuota(model!, await quotas());
      return { model, reason: "pedido explícito" };
    }
    const picked = pickModel(DEFAULT_PRIORITY, await quotas(), avail);
    return { model: picked.model, reason: picked.reason };
  };

  const orch = new Orchestrator({
    herdr: new HerdrCli(),
    store: new Store(join(stateDir, "state.json")),
    tasksDir: join(stateDir, "tasks"),
    workerExtPath: process.env.PI_ORCH_WORKER_EXT ?? resolve(here, "worker-ext.ts"),
    now: () => Date.now(),
    newHex: () => randomBytes(4).toString("hex"),
    availableModels,
    dryRun,
    chooseModel,
    enrichSource: async (input: DelegateInput) => {
      const pr = input.source ? prFromUrl(input.source) : null;
      if (!pr) return input;
      try {
        const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: input.project_path, encoding: "utf8" }).trim();
        const state = await fetchPrState(remote, pr.number, pr.owner, pr.name, input.project_path);
        const conflict = state.mergeStateStatus === "DIRTY" || state.mergeable === "CONFLICTING";
        const note = `${prStateLine(state)} Consultado agora, no lançamento.`;
        return {
          ...input,
          constraints: [...(input.constraints ?? []), note, ...(conflict ? [`A PR está com conflito com a base agora: resolva o conflito no branch da PR antes de corrigir os checks.`] : [])],
        };
      } catch (e) {
        return {
          ...input,
          constraints: [...(input.constraints ?? []), `Não consegui consultar o estado da PR agora (${String(e).slice(0, 160)}). Consulte o estado de merge antes de editar.`],
        };
      }
    },
    onTerminal: (taskId: string) => {
      void fixQueue?.settle(taskId);
    },
  });

  /** Fila de correções de PR: no máximo N workers em paralelo, avançando quando um termina. */
  let fixQueue: FixQueue<DelegateInput> | undefined;
  const hookToken = randomBytes(24).toString("hex");
  let hookHandle: HookHandle | undefined;

  /** Entrega o evento ao orquestrador como turno novo. Falha na conferência da PR não pode perder o aviso. */
  /**
   * Avisos de worker que chegam juntos viram um turno só. Sem isso, cada conclusão gerava um turno do
   * orquestrador (e uma releitura do contexto) mesmo quando chegavam com poucos segundos de diferença.
   */
  const notices = new NoticeBatcher<{ key: string; text: string; event: WatchEvent }>(
    Number(process.env.PI_ORCH_NOTICE_WINDOW_MS ?? 5000),
    (batch) => {
      pi.sendMessage(
        { customType: "orch-event", content: batch.map((b) => b.text).join("\n\n---\n\n"), display: false, details: batch.map((b) => b.event) },
        { triggerTurn: true },
      );
    },
    undefined,
    3,
    (item) => {
      console.error(`pi-orch: aviso ${item.key} não entregue após 3 tentativas`);
    },
  );

  const announce = async (event: WatchEvent): Promise<void> => {
    let prLine = "";
    if (event.status === "done") {
      // Antes de dar uma PR como pronta, confere o estado atual dela no GitHub (conflito, mergeabilidade).
      const task = orch.get(event.task_id);
      for (const url of event.artifacts) {
        const pr = prFromUrl(url);
        if (!pr) continue;
        try {
          const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: task.project_path, encoding: "utf8" }).trim();
          const state = await fetchPrState(remote, pr.number, pr.owner, pr.name, task.project_path);
          prLine += "\n" + verificationLine(state);
        } catch (e) {
          prLine += `\nNão consegui verificar a PR #${pr.number}: ${String(e).slice(0, 160)}. Não dê a tarefa por concluída.`;
        }
      }
    }
    notices.push({ key: `${event.task_id}:${event.status}`, text: modelMessageFor(event) + prLine, event });
  };

  /**
   * Varredura sem LLM: o webhook é só um atalho. Cobre webhook perdido (reinício, endereço velho) e relatório tardio.
   */
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;
  const startSweep = (): void => {
    if (dryRun || sweepTimer) return;
    sweepTimer = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      orch.sweep().then(async (events) => { for (const e of events) await announce(e); }).catch(() => undefined).finally(() => { sweeping = false; });
    }, Number(process.env.PI_ORCH_SWEEP_MS ?? 20_000));
    sweepTimer.unref();
  };

  /** Webhook: o worker faz POST ao terminar. Só diz qual tarefa terminou; o estado vem do relatório em disco. */
  const startHook = async (): Promise<void> => {
    if (dryRun || hookHandle) return;
    hookHandle = await startHook0(hookToken, async (taskId) => {
      const event = await orch.noticeFor(taskId);
      if (event) await announce(event);
    }, Number(process.env.PI_ORCH_HOOK_PORT ?? 0));
    orch.setHook(hookHandle.url, hookToken);
  };

  const startTask = async (input: DelegateInput): Promise<string> => {
    const task = await orch.delegate(input);
    return task.task_id;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (dryRun) return;
    await startHook();
    startSweep();
    // Nome visível no painel do Herdr: mostra que é o orquestrador e em qual pasta. Falha é ignorada.
    const pane = process.env.HERDR_PANE_ID;
    if (pane) {
      execFile("herdr", ["agent", "rename", pane, orchestratorAgentName(ctx.cwd)], { timeout: 15_000 }, () => undefined);
    }
    await orch.reconcile();
    // Resultados que chegaram com o orquestrador fechado ficam pendentes: avisa ao abrir, um turno só se houver algo.
    const pending = await orch.pendingNotices();
    if (pending.length > 0) {
      pi.sendMessage(
        {
          customType: "orch-event",
          content: pending.map((e) => modelMessageFor(e)).join("\n\n---\n\n"),
          display: false,
          details: { pending: pending.map((e) => e.task_id) },
        },
        { triggerTurn: true },
      );
    }
  });

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(FIRST_MATE_ROLE)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${FIRST_MATE_ROLE}` };
  });

  pi.on("session_shutdown", () => {
    // Avisos ainda na janela voltam a ser pendentes: o próximo início os entrega.
    for (const left of notices.drain()) orch.reopenNotice(left.event.task_id);
    hookHandle?.close();
    hookHandle = undefined;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = undefined;
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
      // Antes de lançar qualquer item: escolhe e valida o modelo de todos (falha de cota não deixa lote pela metade).
      const choices = [];
      for (const input of inputs) {
        const choice = await chooseModel(input.model);
        input.model = choice.model;
        choices.push(choice.reason);
      }
      orch.checkBatch(inputs);
      const started = [];
      // Sequencial de propósito: a criação do workspace do projeto não pode correr em paralelo.
      for (const input of inputs) {
        const task = await orch.delegate(input);
        started.push({
          task_id: task.task_id,
          role: task.role,
          status: task.status,
          model: task.model,
          model_reason: choices[inputs.indexOf(input)],
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
      const fresh = inputs.filter((input) => {
        try { orch.checkDelegate(input); return true; } catch { return false; }
      });
      const skipped = inputs.length - fresh.length;
      await fixQueue.enqueue(fresh);
      return asText({
        red_prs: prs.map((pr) => ({ number: pr.number, title: pr.title, branch: pr.headRefName, failing: pr.failing })),
        skipped_already_active: skipped,
        running_task_ids: fixQueue.runningIds,
        queued: fixQueue.pendingCount,
        failed_to_start: fixQueue.failed.map((f) => ({ pr: f.item.role, error: f.error })),
      });
    },
  });

  pi.registerTool({
    name: "orch_locate_project",
    label: "orch locate project",
    description:
      "Procura repositórios git em ~/github pelo nome ou pelo conteúdo de README, AGENTS, CLAUDE e package.json. Devolve candidatos com caminho, remote e termos encontrados. Use antes de pedir ao usuário o caminho de um projeto.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Nome ou termos do projeto, ex.: ensalamento, job oferta." } },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { query: string }) {
      const root = process.env.PI_ORCH_PROJECTS_ROOT ?? join(process.env.HOME ?? "", "github");
      const candidates = locateProject(params.query, root);
      return asText({ query: params.query, root, candidates });
    },
  });

  pi.registerTool({
    name: "orch_status",
    label: "orch status",
    description: "Lista as tarefas e seus estados a partir do estado local. Não consome LLM nem consulta workers.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      await orch.refreshAll();
      return asText(
        orch.list().map((t) => ({
          task_id: t.task_id,
          project_id: t.project_id,
          role: t.role,
          status: t.status,
          model: t.model,
          pane_id: t.pane_id,
          question: t.question,
          deadline_at: formatBrasilia(t.deadline_at),
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
      return asText(await orch.inbox());
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
      void fixQueue?.settle(params.task_id);
      return asText({ task_id: task.task_id, status: task.status });
    },
  });
}
