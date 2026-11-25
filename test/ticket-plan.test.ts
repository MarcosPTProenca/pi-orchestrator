import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchable, PlanStore } from "../src/orchestrator/plans.ts";
import { createPlanFromTickets, planItemsFromTickets } from "../src/orchestrator/ticket-plan.ts";
import { renderSpec, verifySpec } from "../src/shared/spec.ts";
import type { TicketDraft } from "../src/shared/ticket-gate.ts";

const BODY = `# Spec
## Problema
p
## Comportamento
c
## Requisitos
- R1: primeiro comportamento
- R2: segundo comportamento
## Cenários
- S1 (R1): Given a / When b / Then c
- S2 (R2): Given a / When b / Then c
## Non-goals
- nada
## Invariantes
- i
## Validação
- npm test
## Suposições
- s
## Decisões pendentes
- nenhuma
`;
const SPEC = renderSpec(BODY, "approved");
const FP = verifySpec(SPEC).fingerprint;
const TARGET = { project_path: "/repo", mode: "direct-pr" as const };

const tickets: TicketDraft[] = [
  {
    id: "base",
    title: "Primeiro comportamento",
    parent_fingerprint: FP,
    what: "fluxo mínimo",
    requirements: ["R1"],
    scenarios: [{ id: "AC-1", given: "a", when: "b", then: "resultado do primeiro" }],
    context: "",
    test_seams: ["gate puro"],
    non_goals: [],
    blocked_by: [],
    validation: ["npm test"],
    dod: [],
  },
  {
    id: "dependente",
    title: "Segundo comportamento",
    parent_fingerprint: FP,
    what: "estende o fluxo",
    requirements: ["R2"],
    scenarios: [{ id: "AC-2", given: "a", when: "b", then: "resultado do segundo" }],
    context: "",
    test_seams: ["gate puro"],
    non_goals: [],
    blocked_by: ["base"],
    validation: ["npm test"],
    dod: [],
  },
];

test("tickets viram itens do PlanStore com depends_on e delegate, sem scheduler novo", () => {
  const items = planItemsFromTickets(SPEC, tickets, TARGET);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Primeiro comportamento");
  assert.equal(items[1].title, "Segundo comportamento");
  assert.deepEqual(items[1].depends_on, ["1"]);
  assert.equal(items[0].delegate?.objective, "resultado do primeiro");
  assert.equal(items[0].delegate?.request, "fluxo mínimo");
});

test("plano criado pelo PlanStore respeita aprovação e dependências", () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-plan-"));
  const store = new PlanStore(dir);
  const plan = createPlanFromTickets(store, "plano-spec", "Plano da spec", SPEC, tickets, TARGET);
  assert.equal(plan.state, "draft");
  assert.deepEqual(launchable(plan), []);

  const approved = store.act("plano-spec", "approve");
  assert.deepEqual(
    launchable(approved).map((i) => i.id),
    ["1"],
  );
});

test("gate sujo impede a criação do plano", () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-plan-"));
  const store = new PlanStore(dir);
  const broken = [{ ...tickets[0], requirements: ["R1"] }];
  assert.throws(() => createPlanFromTickets(store, "x", "x", SPEC, broken, TARGET), /uncovered_requirement/);
  assert.deepEqual(store.list(), []);
});
