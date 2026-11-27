import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DeliveryEvent, DeliveryName } from "./delivery.ts";

export const ITEM_STATUSES = ["pending", "in_progress", "pr_open", "merged", "done", "blocked"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

const MODES = ["report", "direct-pr", "design"] as const;

export interface PlanDelegate {
  project_path: string;
  role?: string;
  request: string;
  objective: string;
  mode: string;
  model?: string;
  source?: string;
  branch?: string;
}

interface ItemDelivery {
  phase: DeliveryName;
  head_sha: string | null;
  pr: string | null;
  reason: string | null;
}

export type ScopeVerdict = "aligned" | "out_of_scope" | "unverified";

// keep: revisão de escopo entre o done do worker e o avanço do plano; pending enquanto o LLM do orquestrador não devolve o parecer.
export interface ScopeReview {
  verdict: "pending" | ScopeVerdict;
  reason: string | null;
  requested_at: string;
}

export interface PlanItem {
  id: string;
  title: string;
  status: ItemStatus;
  task_id: string | null;
  pr: string | null;
  depends_on: string[];
  delegate: PlanDelegate | null;
  error: string | null;
  delivery: ItemDelivery | null;
  scope: ScopeReview | null;
  updated_at: string;
}

export type PlanState = "draft" | "approved" | "paused" | "cancelled" | "completed";
export type PlanAction = "approve" | "pause" | "cancel";

export interface Plan {
  id: string;
  title: string;
  created_at: string;
  state: PlanState;
  items: PlanItem[];
}

const TRANSITIONS: Record<PlanAction, { from: PlanState[]; to: PlanState }> = {
  approve: { from: ["draft", "paused"], to: "approved" },
  pause: { from: ["approved"], to: "paused" },
  cancel: { from: ["draft", "approved", "paused"], to: "cancelled" },
};

export function nextState(state: PlanState, action: PlanAction): PlanState {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(state)) throw new Error(`não é possível ${actionLabel(action)} um plano ${state}`);
  return rule.to;
}

function actionLabel(action: PlanAction): string {
  return { approve: "aprovar", pause: "pausar", cancel: "cancelar" }[action];
}
export function launchable(plan: Plan): PlanItem[] {
  return plan.state === "approved" ? readyItems(plan) : [];
}

// keep: reservado (in_progress) sem task_id por mais que o limiar = processo caiu entre reserve() e orch.delegate; inFlight são lançamentos ainda em curso nesta sessão.
export function orphanLaunches(
  plan: Plan,
  nowMs: number,
  thresholdMs: number,
  inFlight: ReadonlySet<string>,
): PlanItem[] {
  return plan.items.filter(
    (i) =>
      i.status === "in_progress" &&
      i.task_id === null &&
      i.delegate !== null &&
      !inFlight.has(i.id) &&
      nowMs - Date.parse(i.updated_at) >= thresholdMs,
  );
}

export interface OwnedLaunch {
  task_id: string;
  role: string;
  project_path: string;
  created_at: string;
}

// keep: só adota tarefa criada depois da reserva, com o mesmo papel e projeto; sem match, nada foi lançado (ou não há como provar) e o item não é relançado.
export function findOwnedLaunch(
  item: PlanItem,
  planId: string,
  tasks: OwnedLaunch[],
  taken: ReadonlySet<string> = new Set(),
): string | null {
  const spec = item.delegate;
  if (!spec) return null;
  const role = spec.role ?? `plano-${planId}`;
  const since = Date.parse(item.updated_at);
  const hit = tasks.find(
    (t) =>
      !taken.has(t.task_id) &&
      t.role === role &&
      resolve(t.project_path) === resolve(spec.project_path) &&
      Date.parse(t.created_at) >= since,
  );
  return hit?.task_id ?? null;
}

export function trackedItems(plan: Plan): PlanItem[] {
  return plan.items.filter((i) => i.task_id !== null && (i.status === "in_progress" || i.status === "pr_open"));
}

export type ProjectOwnership = (projectPath: string) => boolean;

export function itemOwnedBy(item: PlanItem, owns: ProjectOwnership): boolean {
  return item.delegate !== null && owns(item.delegate.project_path);
}

export function planOwnedBy(plan: Plan, owns: ProjectOwnership): boolean {
  return plan.items.some((i) => itemOwnedBy(i, owns));
}

function isComplete(plan: Plan): boolean {
  return (
    plan.state === "approved" &&
    plan.items.length > 0 &&
    plan.items.every((i) => i.status === "merged" || i.status === "done")
  );
}

function readyItems(plan: Plan): PlanItem[] {
  const done = new Set(plan.items.filter((i) => DONE_FOR_DEPENDENCY.includes(i.status)).map((i) => i.id));
  return plan.items.filter(
    (i) => i.status === "pending" && i.delegate !== null && i.depends_on.every((d) => done.has(d)),
  );
}

export interface ItemInput {
  title: string;
  depends_on?: string[];
  delegate?: PlanDelegate;
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DONE_FOR_DEPENDENCY: readonly ItemStatus[] = ["merged", "done"];

function checkId(id: string, what: string): void {
  if (!ID.test(id)) throw new Error(`${what} inválido: use minúsculas, números e hífen (até 63 caracteres)`);
}

function checkDelegate(d: PlanDelegate, where: string): void {
  for (const key of ["project_path", "request", "objective"] as const) {
    if (typeof d[key] !== "string" || d[key].trim() === "") throw new Error(`${where}: delegate.${key} obrigatório`);
  }
  if (!(MODES as readonly string[]).includes(d.mode)) throw new Error(`${where}: delegate.mode inválido: ${d.mode}`);
}

function normalize(input: string | ItemInput, index: number): ItemInput {
  if (typeof input === "string") return { title: input };
  if (typeof input !== "object" || input === null || typeof input.title !== "string" || input.title.trim() === "")
    throw new Error(`item ${index + 1} sem título`);
  if (
    input.depends_on !== undefined &&
    (!Array.isArray(input.depends_on) || !input.depends_on.every((d) => typeof d === "string"))
  )
    throw new Error(`item ${index + 1}: depends_on deve ser lista de ids`);
  return input;
}

const ISSUE_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;

// keep: triagem de conjunto de issues exige a origem canônica de cada delegação; sem ela o plano não diz de qual issue veio o trabalho.
export function requireIssueSources(items: (string | ItemInput)[]): void {
  items.forEach((raw, i) => {
    if (typeof raw === "string" || !raw.delegate) return;
    const src = raw.delegate.source;
    if (typeof src !== "string" || !ISSUE_URL.test(src))
      throw new Error(`item ${i + 1}: delegate.source obrigatório, URL de issue do GitHub (.../issues/N)`);
  });
}

export class PlanStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private file(id: string): string {
    checkId(id, "id do plano");
    return join(this.dir, `${id}.json`);
  }

  private write(plan: Plan): void {
    mkdirSync(this.dir, { recursive: true });
    const path = this.file(plan.id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
    renameSync(tmp, path);
  }

  create(id: string, title: string, rawItems: (string | ItemInput)[]): Plan {
    if (existsSync(this.file(id))) throw new Error(`plano ${id} já existe`);
    if (rawItems.length === 0) throw new Error("plano sem itens");
    const at = this.now();
    const ids = rawItems.map((_, i) => `${i + 1}`);
    const items: PlanItem[] = rawItems.map((raw, i) => {
      const input = normalize(raw, i);
      const depends = input.depends_on ?? [];
      for (const dep of depends) {
        const at_ = ids.indexOf(dep);
        if (at_ === -1) throw new Error(`item ${ids[i]}: depende de ${dep}, que não existe`);
        if (at_ >= i) throw new Error(`item ${ids[i]}: só pode depender de itens anteriores (${dep})`);
      }
      if (input.delegate) checkDelegate(input.delegate, `item ${ids[i]}`);
      return {
        id: ids[i],
        title: input.title,
        status: "pending",
        task_id: null,
        pr: null,
        depends_on: depends,
        delegate: input.delegate ?? null,
        error: null,
        delivery: null,
        scope: null,
        updated_at: at,
      };
    });
    const plan: Plan = { id, title, created_at: at, state: "draft", items };
    this.write(plan);
    return plan;
  }

  show(id: string): Plan {
    const path = this.file(id);
    if (!existsSync(path)) throw new Error(`plano ${id} não existe`);
    const plan = JSON.parse(readFileSync(path, "utf8")) as Plan;
    for (const item of plan.items) {
      item.depends_on ??= [];
      item.delegate ??= null;
      item.error ??= null;
      item.delivery ??= null;
      item.scope ??= null;
    }
    plan.state ??= "draft";
    return plan;
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  }

  ready(plan: Plan): PlanItem[] {
    return readyItems(plan);
  }
  act(planId: string, action: PlanAction): Plan {
    const plan = this.show(planId);
    plan.state = nextState(plan.state, action);
    this.write(plan);
    return plan;
  }
  complete(planId: string): Plan {
    const plan = this.show(planId);
    if (!isComplete(plan)) return plan;
    plan.state = "completed";
    this.write(plan);
    return plan;
  }

  // keep: true só na transição para concluído; varreduras seguintes do mesmo plano devolvem false, então o aviso sai uma vez.
  completedNow(planId: string): boolean {
    if (this.show(planId).state === "completed") return false;
    return this.complete(planId).state === "completed";
  }

  update(planId: string, itemId: string, fields: { status?: ItemStatus; task_id?: string; pr?: string }): PlanItem {
    const plan = this.show(planId);
    const item = plan.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`item ${itemId} não existe no plano ${planId}`);
    if (fields.status !== undefined && !(ITEM_STATUSES as readonly string[]).includes(fields.status))
      throw new Error(`status inválido: ${fields.status}`);
    if (fields.task_id !== undefined && !/^t-[0-9a-f]{8}$/.test(fields.task_id))
      throw new Error(`task_id inválido: ${fields.task_id} (formato t-xxxxxxxx)`);
    if (fields.pr !== undefined && !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(fields.pr))
      throw new Error(`pr inválida: ${fields.pr} (URL de PR do GitHub)`);
    if (fields.status !== undefined) item.status = fields.status;
    if (fields.task_id !== undefined) item.task_id = fields.task_id;
    if (fields.pr !== undefined) item.pr = fields.pr;
    item.updated_at = this.now();
    this.write(plan);
    return item;
  }

  reserve(planId: string, itemId: string): PlanItem {
    const plan = this.show(planId);
    const item = plan.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`item ${itemId} não existe no plano ${planId}`);
    if (item.status !== "pending" || item.delegate === null)
      throw new Error(`item ${itemId} não está disponível para reserva`);
    item.status = "in_progress";
    item.updated_at = this.now();
    this.write(plan);
    return item;
  }

  recordDelivery(ev: DeliveryEvent): void {
    for (const planId of this.list()) {
      const plan = this.show(planId);
      let changed = false;
      for (const item of plan.items) {
        if (item.task_id !== ev.task_id) continue;
        const next: ItemDelivery = {
          phase: ev.name,
          head_sha: ev.head_sha ?? null,
          pr: ev.pr ?? item.pr,
          reason: ev.reason ?? null,
        };
        const promote = ev.name === "pr_open" && item.status === "in_progress";
        if (ev.name === "pr_open" && !promote && item.delivery !== null) continue;
        if (!promote && JSON.stringify(item.delivery) === JSON.stringify(next)) continue;
        if (promote) item.status = "pr_open";
        if (ev.name === "pr_open" && ev.pr !== undefined) item.pr = ev.pr;
        item.delivery = next;
        item.updated_at = this.now();
        changed = true;
      }
      if (changed) this.write(plan);
    }
  }

  pausedFor(taskId: string): boolean {
    return this.list().some((planId) => {
      const plan = this.show(planId);
      return (plan.state === "paused" || plan.state === "cancelled") && plan.items.some((i) => i.task_id === taskId);
    });
  }

  launched(planId: string, itemId: string, taskId: string): PlanItem {
    return this.update(planId, itemId, { status: "in_progress", task_id: taskId });
  }

  // keep: só item em execução com a tarefa dada entra na revisão; o avanço do plano depende do parecer gravado aqui.
  requestScope(planId: string, itemId: string): PlanItem {
    const plan = this.show(planId);
    const item = plan.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`item ${itemId} não existe no plano ${planId}`);
    if (item.status !== "in_progress" || item.task_id === null)
      throw new Error(`item ${itemId} não está em execução com tarefa; não há o que revisar`);
    item.scope = { verdict: "pending", reason: null, requested_at: this.now() };
    item.updated_at = this.now();
    this.write(plan);
    return item;
  }

  inProgressFor(taskId: string): { plan: string; item: PlanItem }[] {
    const hits: { plan: string; item: PlanItem }[] = [];
    for (const planId of this.list()) {
      for (const item of this.show(planId).items) {
        if (item.task_id === taskId && item.status === "in_progress") hits.push({ plan: planId, item });
      }
    }
    return hits;
  }

  recordScope(taskId: string, verdict: ScopeVerdict, reason: string): { plan: string; item: string }[] {
    const touched: { plan: string; item: string }[] = [];
    for (const { plan, item } of this.inProgressFor(taskId)) {
      if (item.scope?.verdict !== "pending") continue;
      const p = this.show(plan);
      const target = p.items.find((i) => i.id === item.id);
      if (!target) continue;
      target.scope = { verdict, reason, requested_at: item.scope.requested_at };
      target.updated_at = this.now();
      this.write(p);
      touched.push({ plan, item: item.id });
    }
    return touched;
  }

  blocked(planId: string, itemId: string, error: string): PlanItem {
    const plan = this.show(planId);
    const item = plan.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`item ${itemId} não existe no plano ${planId}`);
    item.status = "blocked";
    item.error = error;
    item.updated_at = this.now();
    this.write(plan);
    return item;
  }

  markTaskDone(taskId: string): { plan: string; item: string }[] {
    return this.transition(taskId, "in_progress", "done");
  }

  markMerged(taskId: string): { plan: string; item: string }[] {
    return this.transition(taskId, "*", "merged");
  }

  private transition(taskId: string, from: ItemStatus | "*", to: ItemStatus): { plan: string; item: string }[] {
    const touched: { plan: string; item: string }[] = [];
    for (const planId of this.list()) {
      try {
        const plan = this.show(planId);
        const hit: { plan: string; item: string }[] = [];
        for (const item of plan.items) {
          const matches = item.task_id === taskId && (from === "*" ? item.status !== to : item.status === from);
          if (matches) {
            item.status = to;
            item.updated_at = this.now();
            hit.push({ plan: planId, item: item.id });
          }
        }
        if (hit.length > 0) {
          this.write(plan);
          touched.push(...hit);
        }
      } catch {
        continue;
      }
    }
    return touched;
  }
}
