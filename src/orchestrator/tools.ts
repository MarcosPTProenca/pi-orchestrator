import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { HerdrCli } from "../shared/herdr.ts";
import { availableModels, resolveModel } from "../shared/models.ts";
import { MODES, type Orchestrator } from "./orchestrator.ts";
import type { DelegateInput } from "../shared/task.ts";
import { fixInputFor, listRedPrs } from "../shared/prs.ts";
import { FixQueue } from "./queue.ts";
import { locateProject } from "./locate.ts";
import { ITEM_STATUSES, requireIssueSources, type ItemInput, type ItemStatus, type PlanStore } from "./plans.ts";
import { EVENT_POLICY, emitEvent, type EventSink } from "../policy/event-policy.ts";
import { capError } from "../policy/cap.ts";
import { summarizeUsage } from "./usage-report.ts";
import { buildStatus, compactStatus, oldHoursFrom } from "./status.ts";
import { tailLog } from "../shared/logs.ts";
import { closeBlocker, idleReport } from "./idle.ts";
import type { orchestratorUsage } from "../shared/usage.ts";
import { asText, compactEvent, formatBrasilia, INBOX_MAX_ITEMS, projectLabel } from "./messages.ts";
import { readVision } from "../shared/intake.ts";
import { missingVisionNotice } from "./scope.ts";

export interface OrchestratorToolContext {
  orch: Orchestrator;
  planStore: PlanStore;
  eventSink: EventSink;
  dryRun: boolean;
  maxActive: number;
  queue: { fix?: FixQueue<DelegateInput> };
  assertWritable: () => void;
  chooseModel: (requested: string | undefined) => Promise<{ model: string | undefined; reason: string }>;
  startTask: (input: DelegateInput) => Promise<string>;
  launchReady: (planId: string) => Promise<void>;
  scopeVerdict: (taskId: string, raw: string) => Promise<string>;
  usage: () => ReturnType<typeof orchestratorUsage> | null;
}

const DELEGATE_ITEM = {
  type: "object",
  properties: {
    project_path: { type: "string", description: "Raiz absoluta do repositório git (checkout principal, com .git)." },
    role: { type: "string", description: "Papel curto, ex.: fix-pr, investigate." },
    request: {
      type: "string",
      description:
        "O trabalho específico que o worker deve executar, formulado por você: o que fazer e sobre qual issue, PR ou arquivo. Não copie pedidos de coordenação do usuário (lançar outros workers, fechar abas ou ociosos): eles ficam com você. Quantidade, modelo, projeto e modo ficam nos campos próprios; restrições do usuário vão em constraints.",
    },
    objective: { type: "string", description: "Como saber que terminou: critério verificável." },
    mode: {
      type: "string",
      enum: [...MODES],
      description:
        "report: só relatório, sem push nem PR. direct-pr: implementa, dá push e abre/atualiza o PR. design: fluxo de especificação e issues.",
    },
    constraints: {
      type: "array",
      items: { type: "string" },
      description: "Restrições do usuário, copiadas. Ex.: não tocar em outros arquivos.",
    },
    source: { type: "string", description: "URL da PR ou issue, quando houver." },
    branch: { type: "string", description: "Branch de trabalho. Omitida: o worker descobre a da PR citada." },
    acceptance: {
      type: "array",
      items: { type: "string" },
      description:
        "Critérios de aceite verificáveis, copiados da fonte. Com critérios, a delegação grava ticket.json e o worker só publica dentro das ações do modo. Sem critérios, a tarefa segue sem ticket (legado).",
    },
    spec: {
      type: "string",
      description: "Especificação de construção, só quando o pedido precisa de passos próprios.",
    },
    allowed_tools: {
      type: "array",
      items: { type: "string" },
      description:
        "Ferramentas liberadas além da política do modo, só quando o trabalho precisa de um sistema externo (ex.: mcp__plane__* para ler o tracker). Padrão: nenhuma. Ficam registradas na tarefa.",
    },
    model: {
      type: "string",
      description:
        "Modelo exato, ex.: claude-bridge/claude-haiku-5-5. Pedido explícito: se indisponível ou sem cota, a chamada falha. Omitido: escolha automática pela cota (haiku 5.5, luna 6, kiro/auto por último).",
    },
    tracker: {
      type: "string",
      enum: ["github", "plane", "none"],
      description: "Onde ficam as issues deste projeto, descoberto pelo contexto (GitHub issues ou Plane).",
    },
    timeout_minutes: {
      type: "number",
      description: "Prazo explícito pedido pelo usuário, em minutos. Omitir = sem prazo.",
    },
    dialogue_budget: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description:
        "Perguntas operacionais que o worker pode fazer antes de o diálogo autônomo bloquear a tarefa. Omitir = PI_ORCH_DIALOGUE_BUDGET ou 3.",
    },
  },
  required: ["project_path", "role", "request", "objective", "mode"],
  additionalProperties: false,
};

export function registerOrchestratorTools(pi: ExtensionAPI, ctx: OrchestratorToolContext): void {
  const { orch, planStore, eventSink, dryRun, maxActive, queue, assertWritable, chooseModel, startTask, launchReady } =
    ctx;
  pi.registerTool({
    name: "orch_delegate",
    label: "orch delegate",
    description:
      "Lança workers Pi com brief completo montado pelo intake. Para N workers, passe N itens em tasks numa única chamada. A chamada inteira é validada antes: se algum item for inválido, nada é lançado. O orquestrador arrenda a worktree de cada worker pelo treehouse antes de lançá-lo; o worker inicia nela.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: DELEGATE_ITEM,
          description:
            "Um item por worker, com o trabalho formulado por você. Pedidos de coordenação do usuário (lançar outros workers, fechar abas ou ociosos) ficam com você.",
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { tasks: Array<Record<string, unknown>> }) {
      assertWritable();
      const inputs = params.tasks as unknown as DelegateInput[];
      const choices = [];
      for (const input of inputs) {
        const choice = await chooseModel(input.model);
        input.model = choice.model;
        choices.push(choice.reason);
      }
      const full = capError(orch.activeCount(), inputs.length, maxActive);
      if (full) throw new Error(full);
      orch.checkBatch(inputs);
      const started = [];
      const notices: string[] = [];
      for (const input of inputs) {
        const vn = missingVisionNotice(input.project_path, readVision(input.project_path));
        if (vn) notices.push(vn);
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
      return asText({
        started_count: started.length,
        dry_run: dryRun,
        started,
        ...(notices.length ? { notices } : {}),
      });
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
        repo_path: {
          type: "string",
          description: "Raiz absoluta do checkout do repositório (com .git e remote origin).",
        },
        model: { type: "string", description: "Modelo exato dos workers. Se indisponível, nada é lançado." },
        concurrency: { type: "number", description: "Workers em paralelo, 1 a 4. Padrão 2." },
      },
      required: ["repo_path"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { repo_path: string; model?: string; concurrency?: number }) {
      assertWritable();
      resolveModel(params.model, availableModels());
      const remote = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: params.repo_path,
        encoding: "utf8",
      }).trim();
      const prs = await listRedPrs(params.repo_path, remote);
      if (prs.length === 0) return asText({ red_prs: 0, message: "nenhuma PR aberta com check vermelho" });
      const concurrency = Math.min(Math.max(params.concurrency ?? 2, 1), 4);
      if (!queue.fix) {
        queue.fix = new FixQueue<DelegateInput>(concurrency, startTask, {
          canStart: () => orch.activeCount() < maxActive,
          onFailed: (f) => {
            emitEvent(eventSink, EVENT_POLICY["queue-failed"], {
              customType: "orch-event",
              content: `Fila de PRs (${projectLabel(basename(f.item.project_path))}): não consegui iniciar a correção de ${f.item.role} após ${f.attempts} tentativas. Erro: ${f.error.slice(0, 300)}`,
              display: true,
            });
          },
        });
      } else if (params.concurrency !== undefined) {
        await queue.fix.setConcurrency(concurrency);
      }
      const inputs = prs.map((pr) => fixInputFor(pr, params.repo_path, params.model));
      const fresh = inputs.filter((input) => !orch.activeConflict(input));
      const skipped = inputs.length - fresh.length;
      const failedMark = queue.fix.failedCount;
      await queue.fix.enqueue(fresh);
      return asText({
        red_prs: prs.map((pr) => ({ number: pr.number, title: pr.title, branch: pr.headRefName, failing: pr.failing })),
        skipped_already_active: skipped,
        running_task_ids: queue.fix.runningIds,
        queued: queue.fix.pendingCount,
        max_active_workers: maxActive,
        active_workers_now: orch.activeCount(),
        failed_to_start: queue.fix.failedSince(failedMark).map((f) => ({ pr: f.item.role, error: f.error })),
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
      properties: {
        query: { type: "string", description: "Nome ou termos do projeto, ex.: ensalamento, job oferta." },
      },
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
    description:
      "Resumo compacto por projeto: contagem por estado, todas as bloqueadas (decisão humana, primeiro) e até 50 ativas por projeto (omitted_open informa quantas ativas ficaram de fora), até 10 terminais recentes por projeto e todas as terminais de atenção (falha, prazo, perda ou verificação não aprovada); omitted_terminal informa quantas terminais recentes ficaram de fora. Resultado truncado a 120 caracteres; error traz o motivo (até 300); links traz as URLs do texto completo; para o texto completo, de uma tarefa, use task_id; detail=true devolve todas as linhas completas. Canceladas e terminais antigas (mais de 24 h) ficam de fora; all=true inclui todas. Não consome avisos do orch_inbox.",
    parameters: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Incluir canceladas e terminais antigas." },
        project_id: { type: "string", description: "Restringe a um projeto." },
        task_id: { type: "string", description: "Uma tarefa, com resultado completo e todos os campos." },
        detail: { type: "boolean", description: "Linhas completas (sem compactar) de todas as tarefas filtradas." },
        usage: {
          type: "boolean",
          description: "Inclui o uso de tokens e turnos da sessão do orquestrador (origem do turno indisponível).",
        },
      },
      additionalProperties: false,
    },
    execute(
      _id: string,
      params: { all?: boolean; project_id?: string; task_id?: string; detail?: boolean; usage?: boolean },
    ) {
      const detail = params.detail === true || params.task_id !== undefined;
      const groups = buildStatus(orch.list(), Date.now(), {
        all: params.all === true || params.task_id !== undefined,
        oldHours: oldHoursFrom(process.env.PI_ORCH_OLD_HOURS),
        projectId: params.project_id,
        taskId: params.task_id,
        fullResult: detail,
      });
      const view = detail ? groups : compactStatus(groups);
      const projects = view.map((g) => ({
        ...g,
        tasks: g.tasks.map((r) => ({ ...r, deadline_at: formatBrasilia(r.deadline_at) })),
      }));
      return Promise.resolve(asText(params.usage === true ? { projects, orquestrador: ctx.usage() } : projects));
    },
  });

  pi.registerTool({
    name: "orch_inbox",
    label: "orch inbox",
    description:
      "Mostra decisões abertas (bloqueadas) e tarefas concluídas, falhas ou expiradas ainda não avisadas: até 40 itens, decisões primeiro. `omitted` conta os que ficaram para a próxima leitura (só os exibidos são marcados como entregues). Por padrão cada aviso terminal aparece uma vez (consume=true). consume=false é leitura pura: não coleta relatórios prontos nem marca avisos como entregues; mostra só o estado já gravado. Resultado truncado a 300 caracteres; links traz as URLs do texto completo; texto completo em orch_status com task_id.",
    parameters: {
      type: "object",
      properties: { consume: { type: "boolean", description: "Marcar avisos terminais como entregues. Padrão true." } },
      additionalProperties: false,
    },
    async execute(_id: string, params: { consume?: boolean }) {
      assertWritable();
      const page = await orch.inboxPage({ consume: params.consume !== false, limit: INBOX_MAX_ITEMS });
      return asText({ items: page.items.map((ev) => compactEvent(ev)), omitted: page.omitted });
    },
  });

  pi.registerTool({
    name: "orch_logs",
    label: "orch logs",
    description:
      "Mostra as últimas linhas do terminal de um worker (padrão 40, máximo 200), para acompanhar sem abrir a tab. Só lê se o painel ainda for da tarefa. Não consome LLM e não altera o estado.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        lines: { type: "number", description: "Linhas, de 1 a 200. Padrão 40." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { task_id: string; lines?: number }) {
      const tail = tailLog(await orch.logs(params.task_id, params.lines));
      return asText({ task_id: params.task_id, ...tail });
    },
  });

  pi.registerTool({
    name: "orch_history",
    label: "orch history",
    description:
      "Mostra a cronologia de uma tarefa: pergunta do worker, entrega ao orquestrador, mensagens e respostas enviadas, relatórios, com remetente, destinatário, status e ID correlacionado. Compacta por padrão (20 itens, texto até 160 caracteres); use offset/next_offset para próxima página e detail=true para o texto completo (até 1200 caracteres por item). Só lê: não consome aviso nem altera estado.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        offset: { type: "number", description: "Item inicial, a partir de 0." },
        limit: { type: "number", description: "Itens por página, de 1 a 50. Padrão 20." },
        detail: { type: "boolean", description: "Traz o texto completo de cada item." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    execute(_id: string, params: { task_id: string; offset?: number; limit?: number; detail?: boolean }) {
      return Promise.resolve(asText({ task_id: params.task_id, ...orch.history(params.task_id, params) }));
    },
  });

  pi.registerTool({
    name: "orch_send",
    label: "orch send",
    description:
      "Envia mensagem a um worker em execução, bloqueado ou concluído. Para continuar trabalho anterior, prefira a tarefa existente: quando concluída, reabre no mesmo painel se ainda existir e pertencer à tarefa. O texto é a instrução concreta do trabalho que resta, compatível com o papel do worker; não repasse pedido de coordenação do usuário. Não interrompe o turno atual. Recusa outros estados e painel que não é mais da tarefa.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        text: { type: "string" },
        ask_id: {
          type: "string",
          description:
            "ID da pergunta operacional do aviso. Obrigatório quando há pergunta pendente do worker; a resposta sai do orquestrador, e repetir a mesma resposta é recusada.",
        },
      },
      required: ["task_id", "text"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { task_id: string; text: string; ask_id?: string }) {
      assertWritable();
      if (orch.get(params.task_id).status === "done") {
        const full = capError(orch.activeCount(), 1, maxActive);
        if (full) throw new Error(full);
      }
      const task = await orch.send(params.task_id, params.text, params.ask_id);
      return asText({ task_id: task.task_id, status: task.status, delivered_after: "turno atual do worker" });
    },
  });

  pi.registerTool({
    name: "orch_relaunch",
    label: "orch relaunch",
    description:
      "Relança uma tarefa que falhou, como tarefa nova ligada à anterior. Falha por cota exige um modelo diferente do que esgotou; outras falhas mantêm o modelo. Nunca roda sozinho: só quando o usuário pede. O novo worker recebe o relatório completo da anterior e, se a sessão dela ainda estiver em disco, uma cópia (fork) da conversa. A tarefa anterior e a sua worktree não mudam.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        model: { type: "string", description: "Modelo exato do relançamento. Obrigatório após falha por cota." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { task_id: string; model?: string }) {
      assertWritable();
      const task = await orch.relaunch(params.task_id, params.model);
      return asText({
        task_id: task.task_id,
        relaunched_from: task.relaunched_from ?? null,
        status: task.status,
        model: task.model,
      });
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
      assertWritable();
      const task = await orch.answer(params.task_id, params.answer);
      return asText({ task_id: task.task_id, status: task.status });
    },
  });

  pi.registerTool({
    name: "orch_plan_create",
    label: "orch plan create",
    description:
      "Registra um plano entregue pelo usuário, fora dos repositórios, em rascunho: não lança nada até orch_plan_approve. Cada item é um título (manual) ou um objeto com `depends_on` (ids de itens anteriores) e `delegate` (especificação de lançamento: project_path, request, objective, mode, source, e opcionalmente role, model, branch, acceptance). `source` é a URL da issue de origem e é obrigatório em cada delegate. `acceptance` (critérios verificáveis) é obrigatório em delegate com mode direct-pr e grava o ticket.json do worker. Itens com `delegate` são lançados sozinhos quando as dependências são concluídas; o orquestrador não precisa ser lembrado.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        items: {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  title: { type: "string" },
                  depends_on: { type: "array", items: { type: "string" } },
                  delegate: {
                    type: "object",
                    properties: {
                      project_path: { type: "string" },
                      role: { type: "string" },
                      request: { type: "string" },
                      objective: { type: "string" },
                      mode: { type: "string", enum: ["report", "direct-pr", "design"] },
                      model: { type: "string" },
                      source: { type: "string", description: "URL da issue de origem (obrigatória)" },
                      branch: { type: "string" },
                      acceptance: {
                        type: "array",
                        items: { type: "string" },
                        description: "Critérios de aceite verificáveis. Obrigatórios em direct-pr.",
                      },
                    },
                    required: ["project_path", "request", "objective", "mode", "source"],
                    additionalProperties: false,
                  },
                },
                required: ["title"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ["id", "title", "items"],
      additionalProperties: false,
    },
    async execute(_id: string, raw: Record<string, unknown>) {
      assertWritable();
      const items = Array.isArray(raw.items) ? (raw.items as (string | ItemInput)[]) : [];
      requireIssueSources(items);
      const plan = planStore.create(String(raw.id ?? ""), String(raw.title ?? ""), items);
      const delegated = plan.items.filter((i) => i.delegate !== null).length;
      return asText({ id: plan.id, items: plan.items.length, lancaveis: delegated });
    },
  });

  pi.registerTool({
    name: "orch_plan_show",
    label: "orch plan show",
    description: "Mostra um plano (itens, status, tarefa e PR de cada um) ou, sem id, lista os planos existentes.",
    parameters: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
    async execute(_id: string, params: { id?: string }) {
      return asText(params.id ? planStore.show(params.id) : { plans: planStore.list() });
    },
  });

  for (const [name, action, label] of [
    [
      "orch_plan_approve",
      "approve",
      "Aprova o plano: a partir daqui os itens com especificação são lançados sozinhos quando as dependências forem concluídas. Retomar um plano pausado também usa esta ferramenta.",
    ],
    [
      "orch_plan_pause",
      "pause",
      "Pausa o plano: nenhum item novo é lançado até aprovar de novo. Tarefas já em andamento não são tocadas.",
    ],
    [
      "orch_plan_cancel",
      "cancel",
      "Cancela o plano: nenhum item novo é lançado. Tarefas já em andamento não são tocadas nem canceladas.",
    ],
  ] as const) {
    pi.registerTool({
      name,
      label: name.replace("_", " "),
      description: label,
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      execute(_id: string, raw: Record<string, unknown>) {
        assertWritable();
        const id = typeof raw.id === "string" ? raw.id : "";
        const plan = planStore.act(id, action);
        const launching = action === "approve" ? launchReady(id) : Promise.resolve();
        return launching.then(() => asText({ id: plan.id, state: planStore.show(id).state }));
      },
    });
  }

  pi.registerTool({
    name: "orch_scope_verdict",
    label: "orch scope verdict",
    description:
      "Registra o seu parecer (orquestrador) sobre a revisão de escopo de um item cujo worker reportou done. raw é o JSON: verdict (aligned, out_of_scope, unverified) e reason. Parecer fora do escopo bloqueia o item.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        raw: { type: "string", description: "JSON do subagent, sem alterações" },
      },
      required: ["task_id", "raw"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { task_id: string; raw: string }) {
      assertWritable();
      return asText(await ctx.scopeVerdict(params.task_id, params.raw));
    },
  });

  pi.registerTool({
    name: "orch_plan_update",
    label: "orch plan update",
    description: `Atualiza um item do plano: status (${ITEM_STATUSES.join(", ")}), tarefa e PR. Só os campos informados mudam.`,
    parameters: {
      type: "object",
      properties: {
        plan: { type: "string" },
        item: { type: "string" },
        status: { type: "string", enum: [...ITEM_STATUSES] },
        task_id: { type: "string" },
        pr: { type: "string" },
      },
      required: ["plan", "item"],
      additionalProperties: false,
    },
    async execute(_id: string, raw: Record<string, unknown>) {
      assertWritable();
      const plan = String(raw.plan ?? "");
      const item = String(raw.item ?? "");
      const fields: { status?: ItemStatus; task_id?: string; pr?: string } = {};
      if (raw.status !== undefined) fields.status = String(raw.status) as ItemStatus;
      if (raw.task_id !== undefined) fields.task_id = String(raw.task_id);
      if (raw.pr !== undefined) fields.pr = String(raw.pr);
      return asText(planStore.update(plan, item, fields));
    },
  });

  pi.registerTool({
    name: "orch_close",
    label: "orch close",
    description:
      "Fecha a tab de uma tarefa já concluída, falha ou expirada, depois que o usuário validou o resultado. Não apaga relatórios.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { task_id: string }) {
      assertWritable();
      const current = orch.list().find((x) => x.task_id === params.task_id);
      const blocked = current ? closeBlocker(current) : null;
      if (blocked) throw new Error(blocked);
      const outcome = await orch.closeOutcome(params.task_id);
      return asText({
        task_id: outcome.task.task_id,
        status: outcome.task.status,
        tab_closed: outcome.closed,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      });
    },
  });

  pi.registerTool({
    name: "orch_usage",
    label: "orch usage",
    description:
      "Mostra o uso de tokens e custo das tarefas desta sessão: totais, taxa de acerto de cache (denominador: entrada + leitura de cache + escrita de cache), custo informado pelo provedor separado do estimado, e totais por modelo. Somente leitura.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute() {
      return Promise.resolve(asText(summarizeUsage(orch.owned().map((t) => ({ model: t.model, usage: t.usage })))));
    },
  });

  pi.registerTool({
    name: "orch_idle",
    label: "orch idle",
    description:
      "Mostra, sem fechar nada, quais tarefas desta sessão são candidatas a fechar (concluídas, entregues, com tab confirmada) e o motivo de cada uma das outras não ser candidata.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const herdr = new HerdrCli();
      const live = { tabIds: await herdr.tabIds(), panes: await herdr.panes() };
      return asText(idleReport(orch.owned(), live));
    },
  });

  pi.registerTool({
    name: "orch_release",
    label: "orch release",
    description:
      "Devolve ao pool a worktree de uma tarefa já terminal, só se não houver alterações não commitadas e o HEAD já estiver num remoto. Nunca força. Não fecha a tab e não apaga relatórios.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { task_id: string }) {
      assertWritable();
      const task = orch.release(params.task_id);
      return asText({ task_id: task.task_id, status: task.status, worktree_note: task.worktree_note ?? null });
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
      assertWritable();
      const task = await orch.cancel(params.task_id);
      void queue.fix?.settle(params.task_id).then(() => queue.fix?.pump());
      return asText({ task_id: task.task_id, status: task.status });
    },
  });
}
