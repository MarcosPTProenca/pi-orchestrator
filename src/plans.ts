/**
 * Plano entregue pelo usuário, guardado fora dos repositórios (`<estado>/plans/<id>.json`), como o firstmate guarda o
 * backlog na sua casa privada. Cada item liga a uma tarefa e a uma PR, para o orquestrador conferir o andamento.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ITEM_STATUSES = ["pending", "in_progress", "pr_open", "merged", "done", "blocked"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface PlanItem {
  id: string;
  title: string;
  status: ItemStatus;
  task_id: string | null;
  pr: string | null;
  updated_at: string;
}

export interface Plan {
  id: string;
  title: string;
  created_at: string;
  items: PlanItem[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

function checkId(id: string, what: string): void {
  if (!ID.test(id)) throw new Error(`${what} inválido: use minúsculas, números e hífen (até 63 caracteres)`);
}

export class PlanStore {
  constructor(private readonly dir: string, private readonly now: () => string = () => new Date().toISOString()) {}

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

  create(id: string, title: string, itemTitles: string[]): Plan {
    if (existsSync(this.file(id))) throw new Error(`plano ${id} já existe`);
    if (itemTitles.length === 0) throw new Error("plano sem itens");
    const at = this.now();
    const items = itemTitles.map((t, i) => ({ id: `${i + 1}`, title: t, status: "pending" as ItemStatus, task_id: null, pr: null, updated_at: at }));
    const plan: Plan = { id, title, created_at: at, items };
    this.write(plan);
    return plan;
  }

  show(id: string): Plan {
    const path = this.file(id);
    if (!existsSync(path)) throw new Error(`plano ${id} não existe`);
    return JSON.parse(readFileSync(path, "utf8")) as Plan;
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  }

  /** Atualiza um item. Só os campos informados mudam. */
  update(planId: string, itemId: string, fields: { status?: ItemStatus; task_id?: string; pr?: string }): PlanItem {
    const plan = this.show(planId);
    const item = plan.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`item ${itemId} não existe no plano ${planId}`);
    if (fields.status !== undefined && !(ITEM_STATUSES as readonly string[]).includes(fields.status)) throw new Error(`status inválido: ${fields.status}`);
    if (fields.status !== undefined) item.status = fields.status;
    if (fields.task_id !== undefined) item.task_id = fields.task_id;
    if (fields.pr !== undefined) item.pr = fields.pr;
    item.updated_at = this.now();
    this.write(plan);
    return item;
  }

  /**
   * Quando a tarefa de um item é mergeada, o item vira `merged`. Devolve os planos e itens tocados, para avisar.
   */
  markMerged(taskId: string): { plan: string; item: string }[] {
    const touched: { plan: string; item: string }[] = [];
    for (const planId of this.list()) {
      const plan = this.show(planId);
      let changed = false;
      for (const item of plan.items) {
        if (item.task_id === taskId && item.status !== "merged") {
          item.status = "merged";
          item.updated_at = this.now();
          touched.push({ plan: planId, item: item.id });
          changed = true;
        }
      }
      if (changed) this.write(plan);
    }
    return touched;
  }
}
