import { publicationOrder, checkTickets, type TicketDraft } from "../shared/ticket-gate.ts";
import type { ItemInput, Plan, PlanStore } from "./plans.ts";

type Delegate = NonNullable<ItemInput["delegate"]>;

export function planItemsFromTickets(
  spec: string,
  tickets: TicketDraft[],
  target: Pick<Delegate, "project_path" | "mode" | "role" | "model">,
): ItemInput[] {
  const findings = checkTickets(spec, tickets);
  if (findings.length > 0) {
    throw new Error(`gate bloqueou o plano: ${findings.map((f) => `${f.code}: ${f.message}`).join("; ")}`);
  }
  const order = publicationOrder(tickets);
  const index = new Map(order.map((t, i) => [t.id, `${i + 1}`]));
  return order.map((t) => ({
    title: t.title,
    depends_on: t.blocked_by.map((d) => index.get(d) as string),
    delegate: {
      ...target,
      request: t.what,
      objective: t.scenarios.map((s) => s.then).join(" | "),
      ...(t.source ? { source: t.source } : {}),
      ...(target.mode === "direct-pr" ? { acceptance: t.scenarios.map((s) => s.then) } : {}),
    },
  }));
}

export function createPlanFromTickets(
  store: PlanStore,
  id: string,
  title: string,
  spec: string,
  tickets: TicketDraft[],
  target: Pick<Delegate, "project_path" | "mode" | "role" | "model">,
): Plan {
  return store.create(id, title, planItemsFromTickets(spec, tickets, target));
}
