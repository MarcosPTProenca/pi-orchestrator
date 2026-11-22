import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ITEM_STATUSES = ["pending", "in_progress", "pr_open", "merged", "done", "blocked"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

const MODES = ["report", "direct-pr", "design"] as const;

interface PlanDelegate {
  project_path: string;
  role?: string;
  request: string;
  objective: string;
  mode: string;
  model?: string;
  source?: string;
  branch?: string;
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
  updated_at: string;
}

export interface Plan {
  id: string;
  title: string;
  created_at: string;
  items: PlanItem[];
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
        updated_at: at,
      };
    });
    const plan: Plan = { id, title, created_at: at, items };
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
    }
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
    const done = new Set(plan.items.filter((i) => DONE_FOR_DEPENDENCY.includes(i.status)).map((i) => i.id));
    return plan.items.filter(
      (i) => i.status === "pending" && i.delegate !== null && i.depends_on.every((d) => done.has(d)),
    );
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

  launched(planId: string, itemId: string, taskId: string): PlanItem {
    return this.update(planId, itemId, { status: "in_progress", task_id: taskId });
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
