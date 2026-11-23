import { execFileSync } from "node:child_process";
import { startHook as startHook0, type HookHandle } from "./hook.ts";
import { DEFAULT_PRIORITY, pickModel, checkRequestedQuota, readQuota, type ProviderQuota } from "./quota.ts";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrCli } from "./herdr.ts";
import { availableModels, resolveModel } from "./models.ts";
import { Orchestrator, MODES, type DelegateInput, type WatchEvent } from "./orchestrator.ts";
import { fixInputFor, listRedPrs, prFromUrl, fetchPrState, verificationLine, verifyPr, prStateLine } from "./prs.ts";
import {
  PrActionWatch,
  ciInstruction,
  conflictInstruction,
  failingChecks,
  isPrWatched,
  prUrlOf,
  prVerdict,
  type PrAction,
} from "./pr-watch.ts";
import { judgeDone, type VerifyEnv } from "./verify.ts";
import { existsSync } from "node:fs";
import { FixQueue } from "./queue.ts";
import { locateProject } from "./locate.ts";
import { orchestratorAgentName } from "./label.ts";
import { execFile } from "node:child_process";
import { Store, defaultStateDir } from "./store.ts";
import { PlanStore, ITEM_STATUSES, launchable, type ItemInput, type ItemStatus } from "./plans.ts";
import { EVENT_POLICY, statusKind, wakesLlm } from "./event-policy.ts";
import { summarizeUsage } from "./usage-report.ts";
import { NoticeBatcher } from "./notices.ts";
import { notificationFor, notifyArgs, notifyEnabled } from "./notify.ts";
import { buildStatus, compactStatus, linksIn, oldHoursFrom } from "./status.ts";
import { tailLog } from "./logs.ts";
import { chainDepth, classifyFailure, failureHintFor, MAX_AUTO_RELAUNCH, nextModelFor } from "./failure.ts";
import { capError, maxActiveFrom } from "./cap.ts";
import { isActive, type TaskRecord } from "./contract.ts";
import { orphanLeases, releaseLease, type WorktreeOps } from "./worktrees.ts";
import { closeBlocker, deadTabTaskIds, idleReport, IdleWatch, idleSurfaces } from "./idle.ts";
import { StallWatch, stallNoticeFor } from "./stall.ts";
import { acquireOwnership, legacyAdopter, ownsByRepo, releaseOwnership, scopeKey, scopeOwnerDir } from "./lock.ts";
import { deferredToolsNote, toolExposureFor } from "./tool-exposure.ts";

export const envPositive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
};
const IDLE_CHECK_MS = envPositive(process.env.PI_ORCH_IDLE_MS, 60_000);
const STALL_MIN = envPositive(process.env.PI_ORCH_STALL_MIN, 15);
const PR_CHECK_MS = envPositive(process.env.PI_ORCH_PR_CHECK_MIN, 5) * 60_000;

const treehouseOps: WorktreeOps = {
  status: (repo) => execFileSync("treehouse", ["status"], { cwd: repo, encoding: "utf8", timeout: 30_000 }),
  git: (path, args) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 30_000 }),
  returnTree: (path) => {
    execFileSync("treehouse", ["return", path], { encoding: "utf8", timeout: 60_000 });
  },
};

const here = dirname(fileURLToPath(import.meta.url));

export const FIRST_MATE_ROLE = [
  "# Papel: orquestrador",
  "Você lança workers Pi para o usuário. Não executa o trabalho do projeto.",
  "Procedimento:",
  "1. Reúna: projeto (raiz do repositório), pedido do usuário, objetivo, modo, modelo e quantidade de workers. Se o usuário citar um projeto pelo nome e você não tiver o caminho, use orch_locate_project antes de perguntar.",
  "2. Se o pedido continua trabalho anterior, consulte orch_status com all e reutilize a tarefa existente com orch_send quando possível; envie com orch_send uma instrução concreta para o trabalho que resta, compatível com o papel e o estado da tarefa, sem repassar pedido de coordenação (lançar outros workers, fechar abas ou ociosos) e preservando o fluxo ou skill solicitado. Se não for possível, explique o motivo antes de lançar outra. Para trabalho novo, use orch_delegate ou, para PRs vermelhas, orch_fix_red_prs. Discovery para criar issue ou card não é trabalho novo de worker: não use orch_delegate para isso, siga o parágrafo de pesquisa abaixo.",
  "3. Preserve o que o usuário pediu: quantidade, modelo, projeto, escopo e modo. Não substitua nada em silêncio.",
  "4. Pergunte só se faltar algo que impede o lançamento, ou quando um worker reportar uma decisão nova. Caso contrário, lance.",
  "Nunca recomende nem proponha como opção uma ação pública (push, commit, PR, comentário, merge, fechamento de issue ou PR) que o usuário não pediu. Se um worker sugerir uma, apresente como sugestão do worker, sem recomendação, e espere o usuário decidir.",
  "5. Depois de lançar, diga o que foi lançado e encerre o turno. Não divida trabalho por iniciativa própria.",
  "Pesquisa e levantamento não são seus. Quando faltar contexto externo ou de logs para criar issue ou card, acione os subagents `researcher` (docs, APIs e fatos externos) e `log-researcher` (logs e sessões passadas) e monte o trabalho a partir do relatório deles. Nunca pesquise ou levante sozinho.",
  "Discovery e entrevista com o usuário são seus: conduza você mesmo, na conversa, as perguntas e a síntese das etapas `grill-with-docs`, `to-spec` e `to-tickets`. Não lance worker para conduzir essas etapas. Subagents só levantam fatos: `researcher` e `log-researcher` devolvem evidência e não conduzem a conversa com o usuário.",
  "Pedido claro dentro do seu papel (por exemplo, abrir uma issue de processo com gh) você executa sem pausa e sem lançar worker. Pare só para decisão do usuário, ação destrutiva ou ação pública que ele não pediu. Se não conseguir executar, diga a tentativa e o erro exato; nunca só diga que não fez.",
  "Pergunta de acompanhamento sobre tarefa anterior (andamento, resultado, artefatos): antes de lançar de novo, consulte orch_status com all e o relatório da tarefa (orch_logs, se preciso). Responda com o que já é conhecido, com a data absoluta do relatório (AAAA-MM-DD, não só a idade) e as pendências específicas. Investigue só a lacuna, nunca refaça trabalho que já tem resultado. Diferencie 'não há informação' de 'há resultado, mas pode estar desatualizado'; no segundo caso, diga isso e pergunte se o usuário quer atualizar.",
  "Resultados e decisões chegam como mensagens: apresente-os sem narrar o mecanismo.",
].join("\n");

export function projectLabel(id: string | null | undefined): string {
  return id && id.trim() ? id.trim() : "projeto não identificado";
}

export function taskHeadline(
  t: { project_id: string; task_id: string; delegate_input?: unknown },
  prUrl: string,
  title: string,
): string {
  const objective = (t.delegate_input as { objective?: string } | null | undefined)?.objective ?? "";
  const short = objective.length > 100 ? `${objective.slice(0, 97)}...` : objective;
  const about = short ? ` Objetivo: "${short}".` : "";
  return `${title} (${projectLabel(t.project_id)}, tarefa ${t.task_id}): ${prUrl}.${about}`;
}

export function idleNoticeFor(idle: { task_id: string; project_id: string }[]): string {
  const items = idle.map((s) => `${s.task_id} (${projectLabel(s.project_id)})`).join(", ");
  return `Tarefas concluídas e entregues com aba aberta (${idle.length}): ${items}. Decida por tarefa: se nada depende da aba (PR aberta com CI vermelho, conflito de merge ou review pendente), feche com orch_close; se algo ainda precisa dela, mantenha e diga o motivo.`;
}

export function orphanNoticeFor(orphans: { path: string; holder: string; project: string }[]): string {
  const items = orphans.map((o) => `${projectLabel(o.project)}: ${o.path} (${o.holder})`).join("; ");
  return `Worktrees ainda arrendadas por tarefas terminais (não foram devolvidas): ${items}. Devolver com orch_release só se o usuário pedir; ela recusa o que tiver trabalho não publicado.`;
}

export function modelMessageFor(e: WatchEvent): string {
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)} [truncado; relatório completo no arquivo do worker]` : text;
  const lines = [`[evento de worker] tarefa ${e.task_id} (${projectLabel(e.project_id)}): ${e.status}`];
  if (e.result) lines.push(`Resumo do worker: ${clip(e.result, 1200)}`);
  if (e.question) lines.push(`Pergunta do worker: ${clip(e.question, 600)}`);
  if (e.artifacts.length) lines.push(`Artefatos: ${e.artifacts.join(", ")}`);
  if (e.error) lines.push(`Erro: ${clip(e.error, 400)}`);
  if (e.correction) lines.push(`Correção de aviso anterior: ${clip(e.correction, 400)}`);
  lines.push(
    "",
    "Responda ao usuário em até 5 linhas: o que aconteceu, o que ficou pronto e o que falta validar. Cite URLs de PR quando houver. Não cole o relatório do worker, e não narre o mecanismo.",
    "Se o aviso trouxer uma linha de recuperação (orch_relaunch, orch_logs ou orch_close, com o task_id), repita essa linha para o usuário: é ela que diz como seguir. Nenhuma recuperação é executada sem o pedido dele.",
    "Se houver uma linha de verificação, ela vale mais que o relatório do worker: se disser NÃO VERIFICADA, não diga que a tarefa está concluída; diga o que falta.",
  );
  return lines.join("\n");
}

export function formatEvent(e: WatchEvent): string {
  const ref = `[${e.task_id.slice(-6)}] ${projectLabel(e.project_id)}`;
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

const INBOX_RESULT_MAX = 300;
const INBOX_MAX_ITEMS = 40;

function compactEvent(ev: WatchEvent) {
  const r = ev.result;
  const long = r !== null && r.length > INBOX_RESULT_MAX;
  return {
    ...ev,
    result: r !== null && long ? `${r.slice(0, INBOX_RESULT_MAX - 1)}…` : r,
    result_truncated: long,
    links: linksIn(r),
  };
}

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

export function formatBrasilia(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(iso));
}

const TERMINAL = new Set(["done", "failed", "timeout", "lost"]);

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
    spec: {
      type: "string",
      description: "Especificação de construção, só quando o pedido precisa de passos próprios.",
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
  },
  required: ["project_path", "role", "request", "objective", "mode"],
  additionalProperties: false,
};

export default function orchestratorExtension(pi: ExtensionAPI): void {
  const stateDir = defaultStateDir();
  const dryRun = process.env.PI_ORCH_DRY_RUN === "1";
  let quotaCache: { at: number; quotas: ProviderQuota[] } | undefined;
  const maxActive = maxActiveFrom(process.env.PI_ORCH_MAX_ACTIVE);
  let owner = dryRun;
  let ownerPid: number | undefined;
  let ownerDir: string | undefined;
  const assertWritable = (): void => {
    if (!owner)
      throw new Error(
        `sessão somente leitura: a sessão do orquestrador (pid ${ownerPid ?? "?"}) já cuida deste projeto`,
      );
  };

  const quotas = async (): Promise<ProviderQuota[]> => {
    if (quotaCache && Date.now() - quotaCache.at < 60_000) return quotaCache.quotas;
    const fresh = await readQuota();
    quotaCache = { at: Date.now(), quotas: fresh };
    return fresh;
  };

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
    releaseWorktree: (t) => releaseLease(treehouseOps, t.project_path, t.task_id).message,
    herdr: new HerdrCli(),
    presentationSpaces: process.env.PI_ORCH_PRESENTATION_SPACES === "1",
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
        const remote = execFileSync("git", ["remote", "get-url", "origin"], {
          cwd: input.project_path,
          encoding: "utf8",
        }).trim();
        const state = await fetchPrState(remote, pr.number, pr.owner, pr.name, input.project_path);
        const conflict = state.mergeStateStatus === "DIRTY" || state.mergeable === "CONFLICTING";
        const note = `${prStateLine(state)} Consultado agora, no lançamento.`;
        return {
          ...input,
          constraints: [
            ...(input.constraints ?? []),
            note,
            ...(conflict
              ? [
                  `A PR está com conflito com a base agora: resolva o conflito no branch da PR antes de corrigir os checks.`,
                ]
              : []),
          ],
        };
      } catch (e) {
        return {
          ...input,
          constraints: [
            ...(input.constraints ?? []),
            `Não consegui consultar o estado da PR agora (${String(e).slice(0, 160)}). Consulte o estado de merge antes de editar.`,
          ],
        };
      }
    },
    onTerminal: (taskId: string) => {
      void fixQueue?.settle(taskId).then(() => fixQueue?.pump());
    },
  });

  let fixQueue: FixQueue<DelegateInput> | undefined;
  const hookToken = randomBytes(24).toString("hex");
  let hookHandle: HookHandle | undefined;

  const notices = new NoticeBatcher<{ key: string; text: string; event: WatchEvent }>(
    Number(process.env.PI_ORCH_NOTICE_WINDOW_MS ?? 5000),
    (batch) => {
      pi.sendMessage(
        {
          customType: "orch-event",
          content: batch.map((b) => b.text).join("\n\n---\n\n"),
          display: false,
          details: batch.map((b) => b.event),
        },
        { triggerTurn: batch.some((b) => wakesLlm(statusKind(b.event.status))) },
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
      const task = orch.get(event.task_id);
      const env: VerifyEnv = {
        prCheck: async (url) => {
          const pr = prFromUrl(url);
          if (!pr) return { ok: false, line: `${url} não é PR` };
          const remote = execFileSync("git", ["remote", "get-url", "origin"], {
            cwd: task.project_path,
            encoding: "utf8",
          }).trim();
          const state = await fetchPrState(remote, pr.number, pr.owner, pr.name, task.project_path);
          return { ok: state.state === "MERGED" || verifyPr(state).length === 0, line: verificationLine(state) };
        },
        commitExists: (sha) => {
          try {
            execFileSync("git", ["-C", task.project_path, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
            return true;
          } catch {
            return false;
          }
        },
        pathExists: (path) => existsSync(path),
      };
      const v = await judgeDone(task.mode ?? "", event.status, event.artifacts, env);
      orch.setVerification(event.task_id, v);
      if (v.verdict === "rejected")
        prLine = `\nVerificação REPROVADA: ${v.reason}. Não diga que a tarefa está concluída; diga o que falta.`;
      else if (v.verdict === "unverified")
        prLine = `\nVerificação não concluída: ${v.reason}. Não dê a tarefa por concluída.`;
      else if (v.verdict === "approved") prLine = `\nVerificação aprovada: ${v.reason}`;
    }
    if (notifyEnabled(process.env)) {
      const n = notificationFor(event);
      if (n) execFile("herdr", notifyArgs(n), { timeout: 10_000 }, () => undefined);
    }
    if (event.status === "failed") {
      const task = orch.get(event.task_id);
      const reason = event.result ?? event.error ?? "";
      const kind = classifyFailure(reason);
      const next = kind === "quota" || kind === "auth" ? nextModelFor(task.model ?? "", kind, DEFAULT_PRIORITY) : null;
      const why = kind === "quota" ? "cota esgotada" : "erro de credencial";
      if (
        next &&
        chainDepth(task, (id) => {
          try {
            return orch.get(id);
          } catch {
            return undefined;
          }
        }) < MAX_AUTO_RELAUNCH
      ) {
        try {
          const fresh = await orch.relaunch(event.task_id, next);
          prLine += `\nFalha por ${why} em ${task.model}. Relancei sozinho com ${next}: nova tarefa ${fresh.task_id}. Nenhum relatório confirma a correção do problema anterior; acompanhe a nova tarefa.`;
        } catch (err) {
          prLine += `\nFalha por ${why} em ${task.model}. Tentei relançar com ${next} e não consegui: ${err instanceof Error ? err.message : String(err)}. Decida o próximo passo.`;
        }
      } else if (next) {
        prLine += `\nFalha por ${why} em ${task.model}. Limite de ${MAX_AUTO_RELAUNCH} trocas automáticas atingido; para relançar: orch_relaunch(task_id="${event.task_id}", model="${next}").`;
      } else if (kind === "quota") {
        prLine += `\nCota esgotada em ${task.model}. Não há outro modelo na ordem de prioridade.`;
      } else {
        prLine += failureHintFor(reason, event.task_id);
      }
    }
    notices.push({ key: `${event.task_id}:${event.status}`, text: modelMessageFor(event) + prLine, event });
  };

  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;
  const startSweep = (): void => {
    if (dryRun || sweepTimer) return;
    sweepTimer = setInterval(
      () => {
        if (sweeping) return;
        sweeping = true;
        orch
          .sweep()
          .then(async (events) => {
            for (const e of events) await announce(e);
          })
          .catch(() => undefined)
          .finally(() => {
            sweeping = false;
          });
      },
      Number(process.env.PI_ORCH_SWEEP_MS ?? 20_000),
    );
    sweepTimer.unref();
  };

  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const idleWatch = new IdleWatch();
  let idleChecking = false;
  const stallWatch = new StallWatch();
  const prWatch = new PrActionWatch();
  const prChecked = new Map<string, number>();
  const planStore = new PlanStore(join(defaultStateDir(), "plans"));
  const launchReady = async (planId: string): Promise<void> => {
    for (const item of launchable(planStore.show(planId))) {
      const spec = item.delegate;
      if (!spec) continue;
      try {
        planStore.reserve(planId, item.id);
      } catch {
        continue;
      }
      try {
        const task = await orch.delegate({
          ...spec,
          role: spec.role ?? `plano-${planId}`,
          mode: spec.mode as DelegateInput["mode"],
        });
        planStore.launched(planId, item.id, task.task_id);
        pi.sendMessage(
          {
            customType: "orch-event",
            content: `Plano ${planId}, item ${item.id} (${item.title}): lancei a tarefa ${task.task_id} (${projectLabel(task.project_id)}).`,
            display: true,
          },
          { triggerTurn: wakesLlm(EVENT_POLICY["plan-launched"]) },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        planStore.blocked(planId, item.id, msg);
        pi.sendMessage(
          {
            customType: "orch-event",
            content: `Plano ${planId}, item ${item.id} (${item.title}) não foi lançado: ${msg}. Decida: corrigir a especificação ou seguir manualmente.`,
            display: true,
          },
          { triggerTurn: wakesLlm(EVENT_POLICY["launch-failed"]) },
        );
      }
    }
  };
  const advancePlans = async (): Promise<void> => {
    for (const planId of planStore.list()) {
      await launchReady(planId).catch(() => undefined);
      const plan = planStore.complete(planId);
      if (plan.state === "completed")
        pi.sendMessage(
          {
            customType: "orch-event",
            content: `Plano ${planId} (${plan.title}) concluído: ${plan.items.map((i) => `${i.id} ${i.title}${i.pr ? ` (${i.pr})` : ""}`).join("; ")}.`,
            display: true,
          },
          { triggerTurn: wakesLlm(EVENT_POLICY["plan-completed"]) },
        );
    }
  };
  // keep: a PR é consultada pela tarefa, não pelo pane; a aba pode já ter sido fechada e o plano segue mesmo assim.
  const reconcilePlans = async (): Promise<void> => {
    for (const planId of planStore.list()) {
      const plan = planStore.show(planId);
      for (const item of plan.items) {
        if (item.status !== "in_progress" || !item.task_id) continue;
        try {
          const task = orch.get(item.task_id);
          const url = prUrlOf(task);
          const pr = url ? prFromUrl(url) : null;
          if (task.status === "done" && !url && planStore.markTaskDone(task.task_id).length > 0) {
            pi.sendMessage(
              {
                customType: "orch-event",
                content: `Plano ${planId}, item ${item.id}: tarefa ${task.task_id} concluída sem PR. Lançando o próximo passo.`,
                display: true,
              },
              { triggerTurn: wakesLlm(EVENT_POLICY["plan-transition"]) },
            );
            await advancePlans();
            continue;
          }
          if (!url || !pr || Date.now() - (prChecked.get(task.task_id) ?? 0) < PR_CHECK_MS) continue;
          prChecked.set(task.task_id, Date.now());
          const remote = execFileSync("git", ["remote", "get-url", "origin"], {
            cwd: task.project_path,
            encoding: "utf8",
          }).trim();
          const state = await fetchPrState(remote, pr.number, pr.owner, pr.name, task.project_path);
          if (prVerdict(state) !== "merged") continue;
          planStore.markMerged(task.task_id);
          pi.sendMessage(
            {
              customType: "orch-event",
              content: `Plano ${planId}, item ${item.id}: PR #${pr.number} mergeada (tarefa ${task.task_id}). Lançando o próximo passo.`,
              display: true,
            },
            { triggerTurn: wakesLlm(EVENT_POLICY["plan-transition"]) },
          );
          await advancePlans();
        } catch {
          continue;
        }
      }
    }
  };
  const checkPr = async (
    t: TaskRecord,
    source: string,
    pr: { owner: string; name: string; number: number },
  ): Promise<void> => {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: t.project_path,
      encoding: "utf8",
    }).trim();
    const s = await fetchPrState(remote, pr.number, pr.owner, pr.name, t.project_path);
    const label = projectLabel(t.project_id);
    const verdict = prVerdict(s);
    if (verdict === "merged") {
      prWatch.forget(t.task_id);
      const outcome = await orch.closeOutcome(t.task_id);
      const plan = planStore.markMerged(t.task_id).map((m) => `plano ${m.plan}, item ${m.item}`);
      await advancePlans();
      const closed = outcome.closed ? "Fechei a aba do worker" : "A aba já não existia";
      const planLine = plan.length > 0 ? ` Atualizei ${plan.join("; ")}.` : "";
      const headline = taskHeadline(t, source, `PR #${pr.number} mergeada`);
      pi.sendMessage(
        {
          customType: "orch-event",
          content:
            plan.length > 0
              ? `${headline} ${closed}.${planLine}`
              : `${headline} ${closed}. Confira se há próximo passo e diga ao usuário.`,
          display: true,
        },
        { triggerTurn: plan.length === 0 && wakesLlm(EVENT_POLICY["pr-merged-no-plan"]) },
      );
      return;
    }
    if (verdict === "pending") return;
    const conflict = verdict === "conflict";
    const red = conflict ? [] : failingChecks(s);
    const kind: PrAction | null = conflict ? "conflict" : red.length > 0 ? "ci" : null;
    prWatch.shouldAct(t.task_id, s.headRefOid, conflict, "conflict");
    prWatch.shouldAct(t.task_id, s.headRefOid, red.length > 0, "ci");
    if (kind === null || !prWatch.shouldAct(t.task_id, s.headRefOid, true, kind)) return;
    const text = kind === "conflict" ? conflictInstruction(source) : ciInstruction(source, red);
    const what = kind === "conflict" ? "está com conflito de merge" : `tem checks falhando: ${red.join(", ")}`;
    try {
      await orch.send(t.task_id, text);
      prWatch.markActed(t.task_id, s.headRefOid, kind);
      pi.sendMessage(
        {
          customType: "orch-event",
          content: `${taskHeadline(t, source, `PR #${pr.number} ${what}`)} Acionei o próprio worker para corrigir; acompanho a PR.`,
          display: true,
        },
        { triggerTurn: wakesLlm(EVENT_POLICY["ci-action-sent"]) },
      );
    } catch (err) {
      pi.sendMessage(
        {
          customType: "orch-event",
          content: `PR #${pr.number} de ${t.task_id} (${label}) ${what}, e não consegui acionar o worker: ${err instanceof Error ? err.message : String(err)}. Decida: orch_send manual ou orch_relaunch.`,
          display: true,
        },
        { triggerTurn: wakesLlm(EVENT_POLICY["send-failed"]) },
      );
    }
  };
  const checkIdle = async (): Promise<void> => {
    if (dryRun || idleChecking) return;
    idleChecking = true;
    try {
      const herdr = new HerdrCli();
      const live = { tabIds: await herdr.tabIds(), panes: await herdr.panes() };
      for (const id of deadTabTaskIds(orch.owned(), live)) orch.forgetDeadTab(id);
      const idle = idleSurfaces(orch.owned(), live);
      if (idleWatch.observe(idle)) {
        pi.sendMessage(
          { customType: "orch-event", content: idleNoticeFor(idle), display: true },
          { triggerTurn: wakesLlm(EVENT_POLICY["idle-candidates"]) },
        );
      }
      const running = orch.owned().filter((t) => t.status === "running");
      stallWatch.prune(new Set(running.map((t) => t.task_id)));
      const stalled: { task_id: string; project_id: string }[] = [];
      for (const t of running) {
        const text = await orch.logs(t.task_id, 30).catch(() => null);
        if (text !== null && stallWatch.observe(t.task_id, text, Date.now(), STALL_MIN * 60_000)) stalled.push(t);
      }
      if (stalled.length > 0) {
        pi.sendMessage(
          { customType: "orch-event", content: stallNoticeFor(stalled, STALL_MIN, projectLabel), display: true },
          { triggerTurn: wakesLlm(EVENT_POLICY["worker-stalled"]) },
        );
      }
      for (const t of orch.owned()) {
        const url = prUrlOf(t);
        if (!isPrWatched(t) || !url) continue;
        const pr = prFromUrl(url);
        if (!pr || Date.now() - (prChecked.get(t.task_id) ?? 0) < PR_CHECK_MS) continue;
        prChecked.set(t.task_id, Date.now());
        await checkPr(t, url, pr).catch(() => undefined);
      }
      await reconcilePlans().catch(() => undefined);
    } catch {
      if (idleWatch.fail()) {
        pi.sendMessage(
          {
            customType: "orch-event",
            content: "Não foi possível conferir superfícies ociosas no Herdr; nova tentativa no próximo ciclo.",
            display: true,
          },
          { triggerTurn: wakesLlm(EVENT_POLICY["herdr-check-failed"]) },
        );
      }
    } finally {
      idleChecking = false;
    }
  };
  const startIdleWatch = (): void => {
    if (dryRun || idleTimer) return;
    idleTimer = setInterval(() => void checkIdle(), IDLE_CHECK_MS);
    idleTimer.unref();
  };

  const startHook = async (): Promise<void> => {
    if (dryRun || hookHandle) return;
    hookHandle = await startHook0(
      hookToken,
      async (taskId) => {
        const event = await orch.noticeFor(taskId);
        if (event) await announce(event);
      },
      Number(process.env.PI_ORCH_HOOK_PORT ?? 0),
    );
    orch.setHook(hookHandle.url, hookToken);
  };

  const startTask = async (input: DelegateInput): Promise<string> => {
    const task = await orch.delegate(input);
    return task.task_id;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (dryRun) return;
    const key = scopeKey(ctx.cwd);
    ownerDir = scopeOwnerDir(stateDir, key);
    const own = acquireOwnership(ownerDir);
    owner = own.owner;
    ownerPid = own.holder?.pid;
    if (!owner) {
      pi.sendMessage(
        {
          customType: "orch-event",
          content: `Outra sessão do orquestrador (pid ${ownerPid}) já cuida deste projeto (${ctx.cwd}). Esta sessão está em modo somente leitura: consulta sim; não lança, não responde, não cancela e não avisa.`,
          display: true,
        },
        { triggerTurn: wakesLlm(EVENT_POLICY["readonly-session"]) },
      );
      return;
    }
    orch.setScope(key, (projectPath) => ownsByRepo(projectPath, key, ctx.cwd));
    orch.adoptUnowned(legacyAdopter({ key, cwd: ctx.cwd, stateDir }));
    try {
      const terminal = new Set(
        orch
          .owned()
          .filter((t) => !isActive(t.status))
          .map((t) => t.task_id),
      );
      const projects = [...new Set(orch.owned().map((t) => t.project_path))];
      const orphans = projects.flatMap((p) =>
        orphanLeases(treehouseOps, p, terminal).map((l) => ({ ...l, project: basename(p) })),
      );
      if (orphans.length > 0) {
        pi.sendMessage(
          { customType: "orch-event", content: orphanNoticeFor(orphans), display: true },
          { triggerTurn: wakesLlm(EVENT_POLICY["orphan-worktrees"]) },
        );
      }
    } catch {}
    await checkIdle();
    startIdleWatch();
    await startHook();
    startSweep();
    const pane = process.env.HERDR_PANE_ID;
    if (pane) {
      execFile(
        "herdr",
        ["agent", "rename", pane, orchestratorAgentName(ctx.cwd)],
        { timeout: 15_000 },
        () => undefined,
      );
    }
    await orch.reconcile();
    const pending = await orch.pendingNotices();
    if (pending.length > 0) {
      pi.sendMessage(
        {
          customType: "orch-event",
          content: pending.map((e) => modelMessageFor(e)).join("\n\n---\n\n"),
          display: false,
          details: { pending: pending.map((e) => e.task_id) },
        },
        { triggerTurn: wakesLlm(EVENT_POLICY["pending-replay"]) },
      );
    }
  });

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(FIRST_MATE_ROLE)) return;
    const note = deferredToolsNote();
    return { systemPrompt: `${event.systemPrompt}\n\n${FIRST_MATE_ROLE}${note ? `\n\n${note}` : ""}` };
  });

  pi.on("session_shutdown", () => {
    for (const left of notices.drain()) orch.reopenNotice(left.event.task_id);
    if (owner && !dryRun && ownerDir) releaseOwnership(ownerDir);
    hookHandle?.close();
    hookHandle = undefined;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = undefined;
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = undefined;
    idleWatch.reset();
  });

  pi.registerTool({
    name: "orch_delegate",
    label: "orch delegate",
    description:
      "Lança workers Pi com brief completo montado pelo intake. Para N workers, passe N itens em tasks numa única chamada. A chamada inteira é validada antes: se algum item for inválido, nada é lançado. Cada worker arrenda a própria worktree pelo treehouse.",
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
      if (!fixQueue) {
        fixQueue = new FixQueue<DelegateInput>(concurrency, startTask, {
          canStart: () => orch.activeCount() < maxActive,
          onFailed: (f) => {
            pi.sendMessage(
              {
                customType: "orch-event",
                content: `Fila de PRs (${projectLabel(basename(f.item.project_path))}): não consegui iniciar a correção de ${f.item.role} após ${f.attempts} tentativas. Erro: ${f.error.slice(0, 300)}`,
                display: true,
              },
              { triggerTurn: wakesLlm(EVENT_POLICY["queue-failed"]) },
            );
          },
        });
      } else if (params.concurrency !== undefined) {
        await fixQueue.setConcurrency(concurrency);
      }
      const inputs = prs.map((pr) => fixInputFor(pr, params.repo_path, params.model));
      const fresh = inputs.filter((input) => !orch.activeConflict(input));
      const skipped = inputs.length - fresh.length;
      const failedMark = fixQueue.failedCount;
      await fixQueue.enqueue(fresh);
      return asText({
        red_prs: prs.map((pr) => ({ number: pr.number, title: pr.title, branch: pr.headRefName, failing: pr.failing })),
        skipped_already_active: skipped,
        running_task_ids: fixQueue.runningIds,
        queued: fixQueue.pendingCount,
        max_active_workers: maxActive,
        active_workers_now: orch.activeCount(),
        failed_to_start: fixQueue.failedSince(failedMark).map((f) => ({ pr: f.item.role, error: f.error })),
      });
    },
  });

  pi.registerTool({
    name: "orch_locate_project",
    label: "orch locate project",
    exposure: toolExposureFor("orch_locate_project"),
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
      "Resumo compacto por projeto: contagem por estado, tarefas abertas (ativas ou bloqueadas, bloqueadas primeiro) até 50 por projeto (omitted_open informa quantas ficaram de fora) e até 10 terminais recentes por projeto (omitted_terminal informa quantas ficaram de fora). Resultado truncado a 120 caracteres; links traz as URLs do texto completo; para o texto completo, de uma tarefa, use task_id; detail=true devolve todas as linhas completas. Canceladas e terminais antigas (mais de 24 h) ficam de fora; all=true inclui todas. Não consome avisos do orch_inbox.",
    parameters: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Incluir canceladas e terminais antigas." },
        project_id: { type: "string", description: "Restringe a um projeto." },
        task_id: { type: "string", description: "Uma tarefa, com resultado completo e todos os campos." },
        detail: { type: "boolean", description: "Linhas completas (sem compactar) de todas as tarefas filtradas." },
      },
      additionalProperties: false,
    },
    execute(_id: string, params: { all?: boolean; project_id?: string; task_id?: string; detail?: boolean }) {
      const detail = params.detail === true || params.task_id !== undefined;
      const groups = buildStatus(orch.list(), Date.now(), {
        all: params.all === true || params.task_id !== undefined,
        oldHours: oldHoursFrom(process.env.PI_ORCH_OLD_HOURS),
        projectId: params.project_id,
        taskId: params.task_id,
        fullResult: detail,
      });
      const view = detail ? groups : compactStatus(groups);
      return Promise.resolve(
        asText(
          view.map((g) => ({
            ...g,
            tasks: g.tasks.map((r) => ({ ...r, deadline_at: formatBrasilia(r.deadline_at) })),
          })),
        ),
      );
    },
  });

  pi.registerTool({
    name: "orch_inbox",
    label: "orch inbox",
    description:
      "Mostra decisões abertas (bloqueadas) e tarefas concluídas, falhas ou expiradas ainda não avisadas: até 40 itens, decisões primeiro. `omitted` conta os que ficaram para a próxima leitura (só os exibidos são marcados como entregues). Por padrão cada aviso terminal aparece uma vez (consume=true). consume=false só lê e não marca o aviso como entregue. Resultado truncado a 300 caracteres; links traz as URLs do texto completo; texto completo em orch_status com task_id.",
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
    exposure: toolExposureFor("orch_logs"),
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
    name: "orch_send",
    label: "orch send",
    description:
      "Envia mensagem a um worker em execução, bloqueado ou concluído. Para continuar trabalho anterior, prefira a tarefa existente: quando concluída, reabre no mesmo painel se ainda existir e pertencer à tarefa. O texto é a instrução concreta do trabalho que resta, compatível com o papel do worker; não repasse pedido de coordenação do usuário. Não interrompe o turno atual. Recusa outros estados e painel que não é mais da tarefa.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" }, text: { type: "string" } },
      required: ["task_id", "text"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { task_id: string; text: string }) {
      assertWritable();
      if (orch.get(params.task_id).status === "done") {
        const full = capError(orch.activeCount(), 1, maxActive);
        if (full) throw new Error(full);
      }
      const task = await orch.send(params.task_id, params.text);
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
      "Registra um plano entregue pelo usuário, fora dos repositórios, em rascunho: não lança nada até orch_plan_approve. Cada item é um título (manual) ou um objeto com `depends_on` (ids de itens anteriores) e `delegate` (especificação de lançamento: project_path, request, objective, mode, e opcionalmente role, model, source, branch). Itens com `delegate` são lançados sozinhos quando as dependências são concluídas; o orquestrador não precisa ser lembrado.",
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
                      source: { type: "string" },
                      branch: { type: "string" },
                    },
                    required: ["project_path", "request", "objective", "mode"],
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
      const plan = planStore.create(String(raw.id ?? ""), String(raw.title ?? ""), items);
      const delegated = plan.items.filter((i) => i.delegate !== null).length;
      return asText({ id: plan.id, items: plan.items.length, lancaveis: delegated });
    },
  });

  pi.registerTool({
    name: "orch_plan_show",
    label: "orch plan show",
    exposure: toolExposureFor("orch_plan_show"),
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
        const launching = action === "approve" ? launchReady(id).catch(() => undefined) : Promise.resolve();
        return launching.then(() => asText({ id: plan.id, state: planStore.show(id).state }));
      },
    });
  }

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
    exposure: toolExposureFor("orch_idle"),
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
      void fixQueue?.settle(params.task_id).then(() => fixQueue?.pump());
      return asText({ task_id: task.task_id, status: task.status });
    },
  });
}
