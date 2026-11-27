import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startHook as startHook0, type HookHandle } from "../shared/hook.ts";
import { DEFAULT_PRIORITY, pickModel, checkRequestedQuota, readQuota, type ProviderQuota } from "../shared/quota.ts";
import { HerdrCli } from "../shared/herdr.ts";
import { availableModels, resolveModel } from "../shared/models.ts";
import { cacheWarmingOverride } from "./cache-warming.ts";
import { Orchestrator, type DelegateInput, type WatchEvent } from "./orchestrator.ts";
import { prFromUrl, fetchPrState, verificationLine, verifyPr, prStateLine } from "../shared/prs.ts";
import {
  NoticeClaims,
  PrActionWatch,
  mergedNoticeKey,
  ciInstruction,
  conflictInstruction,
  failingChecks,
  isPrWatched,
  prUrlOf,
  prVerdict,
  type PrAction,
} from "./pr-watch.ts";
import { FixLoopStore, type FixAction, type FixRecord } from "./fix-loop.ts";
import { judgeDone, type VerifyEnv } from "./verify.ts";
import { FixQueue } from "./queue.ts";
import { ORCHESTRATOR_PANE_LABEL, orchestratorAgentName } from "../shared/label.ts";
import { Store, defaultStateDir } from "../shared/store.ts";
import { deliveryFromFix, integrationRoute, repoPolicyFor, ticketFacts } from "./delivery.ts";
import {
  findingsText,
  integrationFixText,
  reviewAssessment,
  reviewEvent,
  reviewRequestText,
} from "./review-verdict.ts";
import { readReview } from "../shared/review-verdict.ts";
import type { ReviewResult } from "../shared/review.ts";
import { ghMergeGithub } from "../shared/merge-gate-github.ts";
import { IntegrationStore, requestIntegration } from "../shared/merge-gate.ts";
import { MergePolicyStore, type ReviewAssessment } from "../shared/merge-policy.ts";
import {
  PlanStore,
  findOwnedLaunch,
  itemOwnedBy,
  launchable,
  orphanLaunches,
  planOwnedBy,
  trackedItems,
  type PlanItem,
} from "./plans.ts";
import { missingVisionNotice, parseScopeVerdict, scopeReviewText, scopeStep } from "./scope.ts";
import { readVision, VISION_FILE } from "../shared/intake.ts";
import { oracleContract, settleOracleVerdict } from "./oracle-ask.ts";
import { consultToken, oracleCallGate, OracleCaptures } from "./oracle-guard.ts";
import { EVENT_POLICY, UI_ENTRY, emitEvent, statusKind, wakesLlm, type EventSink } from "../policy/event-policy.ts";
import { orchestratorUsage } from "../shared/usage.ts";
import { NoticeBatcher } from "./notices.ts";
import { notificationFor, notifyArgs, notifyEnabled } from "../policy/notify.ts";
import { chainDepth, classifyFailure, failureHintFor, MAX_AUTO_RELAUNCH, nextModelFor } from "../policy/failure.ts";
import { launchRoom, maxActiveFrom } from "../policy/cap.ts";
import { isActive, type TaskRecord } from "../shared/contract.ts";
import { inspectLease, orphanLeases, releaseLease, treehouseOps } from "../shared/worktrees.ts";
import { deadTabTaskIds, IdleWatch, idleSurfaces } from "./idle.ts";
import { StallWatch, stallNoticeFor } from "./stall.ts";
import {
  acquireOwnership,
  legacyAdopter,
  ownsByRepo,
  releaseOwnership,
  scopeKey,
  scopeOwnerDir,
} from "../shared/lock.ts";
import { registerOrchestratorTools } from "./tools.ts";
import { ORCHESTRATOR_ROLE } from "./prompts.ts";
import {
  askMessageFor,
  idleNoticeFor,
  modelMessageFor,
  type OrphanLease,
  orphanReleaseNoticeFor,
  projectLabel,
  taskHeadline,
} from "./messages.ts";

export { ORCHESTRATOR_ROLE } from "./prompts.ts";
export {
  formatBrasilia,
  formatEvent,
  idleNoticeFor,
  modelMessageFor,
  orphanReleaseNoticeFor,
  projectLabel,
  taskHeadline,
} from "./messages.ts";

export const envPositive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
};
const IDLE_CHECK_MS = envPositive(process.env.PI_ORCH_IDLE_MS, 60_000);
const STALL_MIN = envPositive(process.env.PI_ORCH_STALL_MIN, 15);
const PR_CHECK_MS = envPositive(process.env.PI_ORCH_PR_CHECK_MIN, 5) * 60_000;

const here = dirname(fileURLToPath(import.meta.url));

const TERMINAL = new Set(["done", "failed", "timeout", "lost"]);
// keep: no escopo do módulo, não da instância: o mesmo arquivo pode ser carregado 2x no processo (-e + .pi/extensions), e cada instância tem estado próprio.
const mergeNotices = new NoticeClaims();

export default function orchestratorExtension(pi: ExtensionAPI): void {
  const eventSink: EventSink = {
    sendMessage: (msg, opts) => pi.sendMessage(msg, opts),
    appendEntry: (type, data) => pi.appendEntry(type, data),
  };
  pi.registerEntryRenderer(UI_ENTRY, (entry) => {
    const text = (entry.data as { content?: string } | undefined)?.content ?? "";
    return { render: () => text.split("\n"), invalidate: () => {} };
  });
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

  const queue: { fix?: FixQueue<DelegateInput> } = {};
  const orch = new Orchestrator({
    releaseWorktree: (t) => releaseLease(treehouseOps, t.project_path, t.task_id).message,
    inspectWorktree: (t) => inspectLease(treehouseOps, t.project_path, t.task_id),
    herdr: new HerdrCli(),
    presentationSpaces: process.env.PI_ORCH_PRESENTATION_SPACES === "1",
    store: new Store(join(stateDir, "state.json")),
    tasksDir: join(stateDir, "tasks"),
    workerExtPath: process.env.PI_ORCH_WORKER_EXT ?? resolve(here, "../worker/worker-ext.ts"),
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
      void queue.fix?.settle(taskId).then(() => queue.fix?.pump());
    },
  });

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
      // keep: confirma só após o envio; se sendMessage lançar, o batcher tenta de novo e o pendente persiste.
      for (const b of batch) orch.markEventDelivered(b.event);
    },
    undefined,
    3,
    (item) => {
      console.error(`pi-orch: aviso ${item.key} não entregue após 3 tentativas; fica pendente para o próximo início`);
    },
  );

  // keep: o aviso de pergunta leva o contrato do Oracle; o replay de pergunta pendente usa o mesmo texto.
  const askTextFor = (event: WatchEvent): string => {
    const task = orch.get(event.task_id);
    const delegate = task.delegate_input as unknown as DelegateInput | null;
    const contract = oracleContract({
      taskId: event.task_id,
      askId: event.ask_id ?? "",
      question: event.question ?? "",
      askContext: event.result ?? "",
      projectLabel: projectLabel(task.project_id),
      projectPath: task.project_path,
      objective: delegate?.objective ?? "",
      source: delegate?.source ?? task.source ?? null,
      visionPath: join(task.project_path, VISION_FILE),
    });
    return askMessageFor(event, contract);
  };

  const announce = async (event: WatchEvent): Promise<void> => {
    if (event.kind === "ask") {
      notices.push({
        key: `${event.task_id}:ask:${event.ask_id ?? event.question}`,
        text: askTextFor(event),
        event,
      });
      return;
    }
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
  const fixLoop = new FixLoopStore(join(defaultStateDir(), "fix-loop.json"), {
    maxAttempts: envPositive(process.env.PI_ORCH_FIX_ATTEMPTS, 2),
  });
  const prChecked = new Map<string, number>();
  const planStore = new PlanStore(join(defaultStateDir(), "plans"));
  const mergePolicies = new MergePolicyStore(join(defaultStateDir(), "merge-policy"));
  const integrations = new IntegrationStore(join(defaultStateDir(), "integration"));
  const reviewNoticed = new Set<string>();
  // keep: lançamentos em curso nesta sessão (planId/itemId); a varredura de órfãos não mexe neles.
  const launching = new Set<string>();
  const ORPHAN_LAUNCH_MS = envPositive(process.env.PI_ORCH_ORPHAN_LAUNCH_MS, 120_000);
  const visionNote = (projectPath: string): string => {
    const vn = missingVisionNotice(projectPath, readVision(projectPath));
    return vn ? ` ${vn}` : "";
  };
  const launchReady = async (planId: string): Promise<void> => {
    const plan = planStore.show(planId);
    for (const item of launchable(plan).filter((i) => itemOwnedBy(i, (p) => orch.ownsProject(p)))) {
      // keep: o teto PI_ORCH_MAX_ACTIVE também vale para o avanço automático; sem vaga o item fica pendente e a próxima varredura tenta de novo.
      if (launchRoom(maxActive, orch.activeCount()) === 0) break;
      const spec = item.delegate;
      if (!spec) continue;
      try {
        planStore.reserve(planId, item.id);
      } catch {
        continue;
      }
      const key = `${planId}/${item.id}`;
      launching.add(key);
      try {
        const task = await orch.delegate({
          ...spec,
          role: spec.role ?? `plano-${planId}`,
          mode: spec.mode as DelegateInput["mode"],
        });
        planStore.launched(planId, item.id, task.task_id);
        emitEvent(eventSink, EVENT_POLICY["plan-launched"], {
          customType: "orch-event",
          content: `Plano ${planId}, item ${item.id} (${item.title}): lancei a tarefa ${task.task_id} (${projectLabel(task.project_id)}).${visionNote(spec.project_path)}`,
          display: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        planStore.blocked(planId, item.id, msg);
        emitEvent(eventSink, EVENT_POLICY["launch-failed"], {
          customType: "orch-event",
          content: `Plano ${planId}, item ${item.id} (${item.title}) não foi lançado: ${msg}. Decida: corrigir a especificação ou seguir manualmente.`,
          display: true,
        });
      } finally {
        launching.delete(key);
      }
    }
  };
  // keep: reserva órfã (processo caiu entre reserve() e orch.delegate) é adotada se a tarefa existe; sem ela, vira blocked e não é relançada, para não duplicar.
  const recoverOrphanLaunches = (): void => {
    for (const planId of planStore.list()) {
      const plan = planStore.show(planId);
      if (!planOwnedBy(plan, (p) => orch.ownsProject(p))) continue;
      const inFlight = new Set(
        [...launching].filter((k) => k.startsWith(`${planId}/`)).map((k) => k.slice(planId.length + 1)),
      );
      for (const item of orphanLaunches(plan, Date.now(), ORPHAN_LAUNCH_MS, inFlight)) {
        // keep: tarefa já atribuída a outro item do plano (mesmo papel e projeto) não pode ser adotada de novo.
        const taken = new Set(planStore.show(planId).items.flatMap((i) => (i.task_id ? [i.task_id] : [])));
        const taskId = findOwnedLaunch(item, planId, orch.owned(), taken);
        if (taskId) {
          planStore.launched(planId, item.id, taskId);
          emitEvent(eventSink, EVENT_POLICY["plan-launched"], {
            customType: "orch-event",
            content: `Plano ${planId}, item ${item.id} (${item.title}): reserva interrompida recuperada; tarefa ${taskId} já existia.`,
            display: true,
          });
          continue;
        }
        const msg = "lançamento interrompido antes de criar a tarefa";
        planStore.blocked(planId, item.id, msg);
        emitEvent(eventSink, EVENT_POLICY["launch-failed"], {
          customType: "orch-event",
          content: `Plano ${planId}, item ${item.id} (${item.title}) não foi lançado: ${msg}. Não relancei para evitar duplicata. Decida: relançar ou seguir manualmente.`,
          display: true,
        });
      }
    }
  };
  const advancePlans = async (): Promise<void> => {
    for (const planId of planStore.list()) {
      if (!planOwnedBy(planStore.show(planId), (p) => orch.ownsProject(p))) continue;
      await launchReady(planId).catch(() => undefined);
      // keep: aviso só na transição para concluído; o plano já concluído é varrido de novo a cada ciclo e não pode reemitir.
      if (!planStore.completedNow(planId)) continue;
      const plan = planStore.show(planId);
      emitEvent(eventSink, EVENT_POLICY["plan-completed"], {
        customType: "orch-event",
        content: `Plano ${planId} (${plan.title}) concluído: ${plan.items.map((i) => `${i.id} ${i.title}${i.pr ? ` (${i.pr})` : ""}`).join("; ")}.`,
        display: true,
      });
    }
  };
  const recordFix = (taskId: string, action: FixAction): void => {
    const ev = deliveryFromFix(action, taskId);
    if (ev) planStore.recordDelivery(ev);
  };
  const reconcilePlans = async (): Promise<void> => {
    recoverOrphanLaunches();
    for (const planId of planStore.list()) {
      const plan = planStore.show(planId);
      for (const item of trackedItems(plan)) {
        if (!item.task_id) continue;
        try {
          const task = orch.get(item.task_id);
          if (!orch.ownsTask(task)) continue;
          const url = prUrlOf(task);
          const pr = url ? prFromUrl(url) : null;
          // keep: item sem PR avança no done; antes disso passa pela revisão de escopo. Item com PR avança no merge, que já é aprovado pelo usuário.
          if (task.status === "done" && !url) {
            await gateDoneWithoutPr(task, planId, item);
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
          if (planStore.markMerged(task.task_id).length === 0) continue;
          emitEvent(eventSink, EVENT_POLICY["plan-transition"], {
            customType: "orch-event",
            content: `Plano ${planId}, item ${item.id}: PR #${pr.number} mergeada (tarefa ${task.task_id}). Lançando o próximo passo.`,
            display: true,
          });
          await advancePlans();
        } catch {
          continue;
        }
      }
    }
    // keep: item pendente por falta de vaga é lançado quando uma tarefa termina, sem turno de LLM.
    await advancePlans().catch(() => undefined);
  };
  const gateDoneWithoutPr = async (task: TaskRecord, planId: string, item: PlanItem): Promise<void> => {
    const step = scopeStep(item.scope, task.verification);
    if (step.action === "wait") return;
    if (step.action === "request") {
      const delegate = item.delegate;
      planStore.requestScope(planId, item.id);
      emitEvent(eventSink, EVENT_POLICY["scope-review"], {
        customType: "orch-event",
        content: scopeReviewText({
          taskId: task.task_id,
          planId,
          itemId: item.id,
          itemTitle: item.title,
          projectLabel: projectLabel(task.project_id),
          projectPath: task.project_path,
          request: delegate?.request ?? item.title,
          objective: delegate?.objective ?? "(não informado)",
          source: delegate?.source ?? task.source ?? null,
          branch: task.branch ?? delegate?.branch ?? null,
          artifacts: task.artifacts,
          vision: readVision(task.project_path),
        }),
        display: true,
      });
      return;
    }
    if (step.action === "block") {
      planStore.blocked(planId, item.id, step.reason);
      emitEvent(eventSink, EVENT_POLICY["scope-blocked"], {
        customType: "orch-event",
        content: `Plano ${planId}, item ${item.id} (${item.title}): tarefa ${task.task_id} ${step.reason}. O plano não avança. Decida: corrigir, ajustar a spec ou seguir manualmente.`,
        display: true,
      });
      return;
    }
    if (planStore.markTaskDone(task.task_id).length === 0) return;
    const scopeLine = item.scope?.verdict === "aligned" ? ` Escopo conferido: ${item.scope.reason}.` : "";
    emitEvent(eventSink, EVENT_POLICY["plan-transition"], {
      customType: "orch-event",
      content: `Plano ${planId}, item ${item.id}: tarefa ${task.task_id} concluída sem PR.${scopeLine} Lançando o próximo passo.`,
      display: true,
    });
    await advancePlans();
  };
  // keep: a captura vem dos hooks do subagent (tool_call/tool_result) e nunca do texto que o orquestrador repassa.
  const oracleCaptures = new OracleCaptures();
  const recordAskVerdict = (taskId: string, askId: string, raw: string): string => {
    const task = orch.get(taskId);
    const capture = oracleCaptures.get(consultToken(taskId, askId));
    return settleOracleVerdict({ taskId, taskDir: task.task_dir, askId, raw, capture });
  };
  // keep: o parecer chega por orch_scope_verdict; reconcilePlans reavalia o item na hora, sem esperar a varredura.
  const recordScopeVerdict = async (taskId: string, raw: string): Promise<string> => {
    const v = parseScopeVerdict(raw);
    const touched = planStore.recordScope(taskId, v.verdict, v.reason);
    if (touched.length === 0) throw new Error(`nenhum item aguarda revisão de escopo para a tarefa ${taskId}`);
    await reconcilePlans().catch(() => undefined);
    return `Parecer de escopo registrado para ${taskId}: ${v.verdict}. ${v.reason}`;
  };
  const requestReview = async (
    t: TaskRecord,
    source: string,
    head: string,
    previous: FixRecord | null,
  ): Promise<void> => {
    try {
      await orch.send(t.task_id, reviewRequestText(source, head));
    } catch (err) {
      fixLoop.restore(t.task_id, previous);
      emitEvent(eventSink, EVENT_POLICY["send-failed"], {
        customType: "orch-event",
        content: `${taskHeadline(t, source, "PR pede review fresh")} Não consegui acionar o worker: ${err instanceof Error ? err.message : String(err)}. Decida: orch_send manual.`,
        display: true,
      });
    }
  };
  const mergeApproved = async (
    t: TaskRecord,
    source: string,
    pr: { owner: string; name: string; number: number },
    remote: string,
    head: string,
    assessment: ReviewAssessment | null,
  ): Promise<void> => {
    const result = await requestIntegration(
      {
        repo: `${pr.owner}/${pr.name}`,
        number: pr.number,
        expected_head_sha: head,
        policy: repoPolicyFor(mergePolicies, `${pr.owner}/${pr.name}`, t.task_id),
        ticket: ticketFacts(t),
        reviewer: null,
        review: { head_sha: head, approved: true, assessment },
      },
      { github: ghMergeGithub(remote, t.project_path), store: integrations },
    );
    const route = integrationRoute(result);
    if (route.kind === "merge_requested") {
      planStore.recordDelivery({ name: "merge_eligible", task_id: t.task_id, head_sha: head });
      return;
    }
    const key = `${t.task_id}@${head}`;
    if (reviewNoticed.has(key)) return;
    reviewNoticed.add(key);
    if (route.kind === "ask_worker") {
      try {
        await orch.send(t.task_id, integrationFixText(source, head, route.reasons));
      } catch (err) {
        emitEvent(eventSink, EVENT_POLICY["send-failed"], {
          customType: "orch-event",
          content: `${taskHeadline(t, source, `PR #${pr.number} aprovada, merge pendente`)} Não consegui enviar ao worker o que falta: ${err instanceof Error ? err.message : String(err)}. Decida: orch_send manual.`,
          display: true,
        });
      }
      return;
    }
    const why = route.reasons.join("; ");
    emitEvent(eventSink, EVENT_POLICY["review-approved"], {
      customType: "orch-event",
      content: route.manual
        ? `${taskHeadline(t, source, `PR #${pr.number} aprovada pelo review`)} Precisa da sua aprovação para o merge: ${why}. Decida: aprovar o merge ou não. O plano avança quando a PR for mergeada.`
        : `${taskHeadline(t, source, `PR #${pr.number} aprovada pelo review`)} Merge automático não pedido: ${why}. O plano avança quando a PR for mergeada.`,
      display: true,
    });
  };
  const applyReview = async (
    t: TaskRecord,
    source: string,
    pr: { owner: string; name: string; number: number },
    remote: string,
    head: string,
    review: ReviewResult,
  ): Promise<void> => {
    const out = fixLoop.apply(t.task_id, reviewEvent(review));
    if (out.action.kind === "approved") return mergeApproved(t, source, pr, remote, head, reviewAssessment(review));
    recordFix(t.task_id, out.action);
    if (out.action.kind === "send_findings") {
      try {
        await orch.send(t.task_id, findingsText(source, head, review));
      } catch (err) {
        fixLoop.restore(t.task_id, out.previous);
        emitEvent(eventSink, EVENT_POLICY["send-failed"], {
          customType: "orch-event",
          content: `${taskHeadline(t, source, `PR #${pr.number} reprovada pelo review`)} Não consegui enviar os achados ao worker: ${err instanceof Error ? err.message : String(err)}. Decida: orch_send manual.`,
          display: true,
        });
      }
    } else if (out.action.kind === "blocked") {
      emitEvent(eventSink, EVENT_POLICY["fix-blocked"], {
        customType: "orch-event",
        content: `${taskHeadline(t, source, `PR #${pr.number} reprovada pelo review`)} ${out.action.reason}. Decida: corrigir manualmente ou orch_send.`,
        display: true,
      });
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
      const noticeKey = mergedNoticeKey(t.task_id, source, s.headRefOid);
      if (!mergeNotices.claim(noticeKey)) return;
      try {
        prWatch.forget(t.task_id);
        fixLoop.apply(t.task_id, { type: "revoke", reason: "PR mergeada" });
        const outcome = await orch.closeMerged(t.task_id);
        const plan = planStore.markMerged(t.task_id).map((m) => `plano ${m.plan}, item ${m.item}`);
        planStore.recordDelivery({ name: "merged", task_id: t.task_id, pr: source });
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
      } catch (err) {
        mergeNotices.release(noticeKey);
        throw err;
      }
      return;
    }
    planStore.recordDelivery({ name: "pr_open", task_id: t.task_id, pr: source, head_sha: s.headRefOid });
    if (verdict === "pending" || planStore.pausedFor(t.task_id)) return;
    const head = fixLoop.apply(t.task_id, { type: "head", head_sha: s.headRefOid });
    recordFix(t.task_id, head.action);
    if (head.action.kind === "request_review") await requestReview(t, source, s.headRefOid, head.previous);
    const review = readReview(t.task_dir, s.headRefOid);
    if (review) await applyReview(t, source, pr, remote, s.headRefOid, review);
    const conflict = verdict === "conflict";
    const red = conflict ? [] : failingChecks(s);
    const kind: PrAction | null = conflict ? "conflict" : red.length > 0 ? "ci" : null;
    prWatch.shouldAct(t.task_id, s.headRefOid, conflict, "conflict");
    prWatch.shouldAct(t.task_id, s.headRefOid, red.length > 0, "ci");
    if (kind === null || !prWatch.shouldAct(t.task_id, s.headRefOid, true, kind)) return;
    let fix: { action: FixAction; previous: FixRecord | null } | null = null;
    if (kind === "ci") {
      fix = fixLoop.apply(t.task_id, { type: "ci_red", head_sha: s.headRefOid, checks: red });
      recordFix(t.task_id, fix.action);
      if (fix.action.kind === "blocked") {
        emitEvent(eventSink, EVENT_POLICY["fix-blocked"], {
          customType: "orch-event",
          content: `${taskHeadline(t, source, `PR #${pr.number} com CI vermelho`)} ${fix.action.reason}. Decida: corrigir manualmente ou orch_send.`,
          display: true,
        });
        return;
      }
      if (fix.action.kind !== "send_ci_fix") return;
    }
    const text = kind === "conflict" ? conflictInstruction(source) : ciInstruction(source, red);
    const what = kind === "conflict" ? "está com conflito de merge" : `tem checks falhando: ${red.join(", ")}`;
    try {
      await orch.send(t.task_id, text);
      prWatch.markActed(t.task_id, s.headRefOid, kind);
      emitEvent(eventSink, EVENT_POLICY["ci-action-sent"], {
        customType: "orch-event",
        content: `${taskHeadline(t, source, `PR #${pr.number} ${what}`)} Acionei o próprio worker para corrigir; acompanho a PR.`,
        display: true,
      });
    } catch (err) {
      if (fix) fixLoop.restore(t.task_id, fix.previous);
      emitEvent(eventSink, EVENT_POLICY["send-failed"], {
        customType: "orch-event",
        content: `PR #${pr.number} de ${t.task_id} (${label}) ${what}, e não consegui acionar o worker: ${err instanceof Error ? err.message : String(err)}. Decida: orch_send manual ou orch_relaunch.`,
        display: true,
      });
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
        emitEvent(eventSink, EVENT_POLICY["idle-candidates"], {
          customType: "orch-event",
          content: idleNoticeFor(idle),
          display: true,
        });
      }
      const running = orch.owned().filter((t) => t.status === "running");
      stallWatch.prune(new Set(running.map((t) => t.task_id)));
      const stalled: { task_id: string; project_id: string }[] = [];
      for (const t of running) {
        const text = await orch.logs(t.task_id, 30).catch(() => null);
        if (text !== null && stallWatch.observe(t.task_id, text, Date.now(), STALL_MIN * 60_000)) stalled.push(t);
      }
      if (stalled.length > 0) {
        emitEvent(eventSink, EVENT_POLICY["worker-stalled"], {
          customType: "orch-event",
          content: stallNoticeFor(stalled, STALL_MIN, projectLabel),
          display: true,
        });
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
        emitEvent(eventSink, EVENT_POLICY["herdr-check-failed"], {
          customType: "orch-event",
          content: "Não foi possível conferir superfícies ociosas no Herdr; nova tentativa no próximo ciclo.",
          display: true,
        });
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

  let orchUsage: ReturnType<typeof orchestratorUsage> | null = null;
  pi.on("session_start", (_event, ctx) => {
    orchUsage = orchestratorUsage(ctx.sessionManager.getEntries());
  });
  pi.on("agent_end", (_event, ctx) => {
    orchUsage = orchestratorUsage(ctx.sessionManager.getEntries());
  });

  pi.on("session_start", async (_event, ctx) => {
    if (dryRun) return;
    const key = scopeKey(ctx.cwd);
    ownerDir = scopeOwnerDir(stateDir, key);
    const own = acquireOwnership(ownerDir);
    owner = own.owner;
    ownerPid = own.holder?.pid;
    if (!owner) {
      emitEvent(eventSink, EVENT_POLICY["readonly-session"], {
        customType: "orch-event",
        content: `Outra sessão do orquestrador (pid ${ownerPid}) já cuida deste projeto (${ctx.cwd}). Esta sessão está em modo somente leitura: consulta sim; não lança, não responde, não cancela e não avisa.`,
        display: true,
      });
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
      const leasesNow = (): OrphanLease[] =>
        projects.flatMap((p) => orphanLeases(treehouseOps, p, terminal).map((l) => ({ ...l, project: basename(p) })));
      const orphans = leasesNow();
      if (orphans.length > 0) {
        for (const o of orphans) {
          try {
            orch.release(o.holder);
          } catch {}
        }
        const stillLeased = new Set(leasesNow().map((o) => o.path));
        const released = orphans.filter((o) => !stillLeased.has(o.path));
        const kept = orphans
          .filter((o) => stillLeased.has(o.path))
          .map((o) => ({ ...o, note: orch.get(o.holder).worktree_note ?? "motivo não registrado" }));
        emitEvent(eventSink, EVENT_POLICY["orphan-worktrees"], {
          customType: "orch-event",
          content: orphanReleaseNoticeFor({ released, kept }),
          display: true,
        });
      }
    } catch {}
    await checkIdle();
    startIdleWatch();
    await startHook();
    startSweep();
    const pane = process.env.HERDR_PANE_ID;
    if (pane) {
      // keep: só o pane próprio da sessão; nunca renomeia pane de worker ou de terceiros.
      execFile(
        "herdr",
        ["agent", "rename", pane, orchestratorAgentName(ctx.cwd)],
        { timeout: 15_000 },
        () => undefined,
      );
      execFile("herdr", ["pane", "rename", pane, ORCHESTRATOR_PANE_LABEL], { timeout: 15_000 }, () => undefined);
    }
    await orch.reconcile();
    const pending = await orch.pendingNotices();
    if (pending.length > 0) {
      emitEvent(eventSink, EVENT_POLICY["pending-replay"], {
        customType: "orch-event",
        content: pending.map((e) => (e.kind === "ask" ? askTextFor(e) : modelMessageFor(e))).join("\n\n---\n\n"),
        display: false,
        details: { pending: pending.map((e) => e.task_id) },
      });
      for (const e of pending) orch.markEventDelivered(e);
    }
  });

  pi.on("cache_warming_decision", () => cacheWarmingOverride());
  // keep: o gate roda antes do subagent; agente do Oracle sem bash e sem escrita não chega a ser lançado.
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return undefined;
    const reason = oracleCallGate({ agent: event.input.agent, cwd: ctx.cwd });
    if (reason) return { block: true, reason };
    oracleCaptures.noteCall(event.toolCallId, event.input);
    return undefined;
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "subagent") return;
    const output = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    oracleCaptures.noteResult(event.toolCallId, output, event.isError);
  });

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(ORCHESTRATOR_ROLE)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_ROLE}` };
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

  registerOrchestratorTools(pi, {
    orch,
    planStore,
    eventSink,
    dryRun,
    maxActive,
    queue,
    assertWritable,
    chooseModel,
    startTask,
    launchReady,
    scopeVerdict: recordScopeVerdict,
    askVerdict: recordAskVerdict,
    usage: () => orchUsage,
  });
}
