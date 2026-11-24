import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSpec, verifySpec } from "../src/shared/spec.ts";
import {
  checkTickets,
  proposeTickets,
  publicationOrder,
  publishTickets,
  staleTickets,
  type TicketDraft,
} from "../src/shared/ticket-gate.ts";

const BODY = `# Spec de exemplo
## Problema
Tickets saem sem cobertura de requisitos.
## Comportamento
Gate valida a proposta antes de publicar.
## Requisitos
- R1: proposta nasce sem efeito colateral
- R2: gate bloqueia requisito sem cobertura
- R3: publicação exige aprovação do usuário
## Cenários
- S1 (R1): Given spec aprovada / When gero propostas / Then nenhuma issue é criada
- S2 (R2): Given requisito órfão / When valido / Then o gate reporta uncovered_requirement
- S3 (R3): Given proposta pronta / When publico sem aprovação / Then a publicação é recusada
## Non-goals
- segundo issue tracker
## Invariantes
- proposta é determinística
## Validação
- npm test
## Suposições
- GitHub é o tracker
## Decisões pendentes
- nenhuma
`;

const SPEC = renderSpec(BODY, "approved");
const FP = verifySpec(SPEC).fingerprint;

function ticket(over: Partial<TicketDraft> & { id: string }): TicketDraft {
  return {
    title: `Comportamento ${over.id}`,
    parent_fingerprint: FP,
    what: "resultado demoável ponta a ponta",
    requirements: ["R1"],
    scenarios: [{ id: `AC-${over.id}`, given: "dado", when: "quando", then: "então" }],
    context: "",
    test_seams: ["função pura do gate"],
    non_goals: ["sem UI"],
    blocked_by: [],
    validation: ["npm test"],
    dod: ["testes verdes"],
    ...over,
  };
}

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

test("feature fatiada em tracer bullets verticais passa o gate e renderiza template completo", () => {
  const tickets = [
    ticket({ id: "fluxo-minimo", requirements: ["R1"], what: "proposta gerada de ponta a ponta" }),
    ticket({ id: "gate-cobertura", requirements: ["R2"], blocked_by: ["fluxo-minimo"], what: "gate aponta órfão" }),
    ticket({
      id: "publicacao-aprovada",
      requirements: ["R3"],
      blocked_by: ["gate-cobertura"],
      what: "publica após aprovação",
    }),
  ];
  const proposal = proposeTickets(SPEC, tickets);
  assert.equal(proposal.status, "ready");
  assert.deepEqual(proposal.findings, []);
  assert.deepEqual(
    proposal.issues.map((i) => i.id),
    ["fluxo-minimo", "gate-cobertura", "publicacao-aprovada"],
  );
  const md = proposal.issues[1].markdown;
  for (const section of [
    "## Parent",
    "## What to build",
    "## RQ-IDs",
    "## AC-IDs",
    "## test_seams",
    "## Blocked by",
    "## Validation",
    "## DoD",
  ]) {
    assert.ok(md.includes(section), `falta ${section}`);
  }
  assert.ok(md.includes(`Spec fingerprint: \`${FP}\``));
  assert.ok(md.includes("pendente de publicação"));
});

test("refactor expand-contract e bug simples com um único ticket também passam", () => {
  const refactor = [
    ticket({ id: "expandir", requirements: ["R1"], title: "Aceitar formato novo em paralelo" }),
    ticket({ id: "contrair", requirements: ["R2", "R3"], blocked_by: ["expandir"], title: "Remover formato antigo" }),
  ];
  assert.deepEqual(checkTickets(SPEC, refactor), []);
  const bug = [ticket({ id: "corrigir-gate", requirements: ["R2", "R1", "R3"], title: "Gate aceita órfão" })];
  assert.deepEqual(checkTickets(SPEC, bug), []);
});

test("spec não aprovada bloqueia a proposta", () => {
  const draft = renderSpec(BODY, "reviewed");
  const fp = verifySpec(draft).fingerprint;
  const findings = checkTickets(draft, [ticket({ id: "a", parent_fingerprint: fp, requirements: ["R1", "R2", "R3"] })]);
  assert.ok(codes(findings).includes("spec_not_approved"));
});

test("requisito sem cobertura é detectado", () => {
  const findings = checkTickets(SPEC, [ticket({ id: "a", requirements: ["R1", "R2"] })]);
  assert.deepEqual(codes(findings), ["uncovered_requirement"]);
  assert.match(findings[0].message, /R3/);
});

test("critério incompleto e ausência de validação são detectados", () => {
  const partial = ticket({
    id: "a",
    requirements: ["R1", "R2", "R3"],
    scenarios: [{ id: "AC-a", given: "dado", when: "", then: "então" }],
  });
  assert.ok(codes(checkTickets(SPEC, [partial])).includes("scenario_incomplete"));
  const noValidation = ticket({ id: "a", requirements: ["R1", "R2", "R3"], validation: [] });
  assert.ok(codes(checkTickets(SPEC, [noValidation])).includes("missing_validation"));
});

test("referência inválida: RQ inexistente e blocker ausente", () => {
  const findings = checkTickets(SPEC, [
    ticket({ id: "a", requirements: ["R1", "R2", "R3", "R9"], blocked_by: ["fantasma"] }),
  ]);
  const invalid = findings.filter((f) => f.code === "invalid_reference");
  assert.equal(invalid.length, 2);
});

test("dependência cíclica e auto-bloqueio são detectados", () => {
  const cyc = [
    ticket({ id: "a", requirements: ["R1"], blocked_by: ["b"] }),
    ticket({ id: "b", requirements: ["R2"], blocked_by: ["a"] }),
    ticket({ id: "c", requirements: ["R3"] }),
  ];
  const findings = checkTickets(SPEC, cyc);
  assert.ok(codes(findings).includes("dependency_cycle"));
  assert.throws(() => publicationOrder(cyc), /ciclo/);

  const self = [ticket({ id: "s", requirements: ["R1", "R2", "R3"], blocked_by: ["s"] })];
  assert.ok(codes(checkTickets(SPEC, self)).includes("dependency_cycle"));
});

test("título de camada técnica é recusado como não vertical", () => {
  const findings = checkTickets(SPEC, [
    ticket({ id: "a", requirements: ["R1", "R2", "R3"], title: "Criar tabela de tickets" }),
  ]);
  assert.ok(codes(findings).includes("horizontal_slice"));
});

test("duplicidade de id e de título são detectadas", () => {
  const findings = checkTickets(SPEC, [
    ticket({ id: "a", requirements: ["R1"], title: "Mesmo nome" }),
    ticket({ id: "a", requirements: ["R2", "R3"], title: "Mesmo nome" }),
  ]);
  assert.ok(codes(findings).includes("duplicate_id"));
  assert.ok(codes(findings).includes("duplicate_title"));
});

test("spec alterada marca tickets como obsoletos sem atualizá-los", () => {
  const tickets = [ticket({ id: "a", requirements: ["R1", "R2", "R3"] })];
  assert.deepEqual(staleTickets(tickets, SPEC), []);
  const changed = renderSpec(BODY.replace("npm test", "npm run quality"), "approved");
  assert.deepEqual(staleTickets(tickets, changed), ["a"]);
  assert.ok(codes(checkTickets(changed, tickets)).includes("stale_parent"));
  assert.equal(tickets[0].parent_fingerprint, FP);
});

test("sem aprovação do usuário a publicação é recusada e nada é criado", async () => {
  const tickets = [ticket({ id: "a", requirements: ["R1", "R2", "R3"] })];
  const calls: string[] = [];
  const publisher = (issue: { id: string }) => {
    calls.push(issue.id);
    return Promise.resolve("#1");
  };
  await assert.rejects(publishTickets(SPEC, tickets, "agent" as "user", publisher), /aprovação do usuário/);
  assert.deepEqual(calls, []);
});

test("publicação com gate sujo é recusada mesmo com aprovação", async () => {
  const tickets = [ticket({ id: "a", requirements: ["R1"] })];
  await assert.rejects(
    publishTickets(SPEC, tickets, "user", () => Promise.resolve("#1")),
    /uncovered_requirement/,
  );
});

test("publicação usa refs reais nos blockers e respeita a ordem", async () => {
  const tickets = [
    ticket({ id: "segundo", requirements: ["R2"], blocked_by: ["primeiro"] }),
    ticket({ id: "primeiro", requirements: ["R1", "R3"] }),
  ];
  const seen: { id: string; markdown: string }[] = [];
  const numbers = [101, 102];
  const result = await publishTickets(SPEC, tickets, "user", (issue) => {
    seen.push(issue);
    return Promise.resolve(`#${numbers.shift()}`);
  });
  assert.deepEqual(
    seen.map((s) => s.id),
    ["primeiro", "segundo"],
  );
  assert.ok(seen[1].markdown.includes("- #101"));
  assert.deepEqual(result, {
    published: [
      { id: "primeiro", ref: "#101" },
      { id: "segundo", ref: "#102" },
    ],
    failed: null,
    pending: [],
  });
});

test("erro parcial na publicação para no ponto da falha e informa o que ficou criado", async () => {
  const tickets = [
    ticket({ id: "um", requirements: ["R1"] }),
    ticket({ id: "dois", requirements: ["R2"], blocked_by: ["um"] }),
    ticket({ id: "tres", requirements: ["R3"], blocked_by: ["dois"] }),
  ];
  let n = 0;
  const result = await publishTickets(SPEC, tickets, "user", () => {
    n++;
    if (n === 2) return Promise.reject(new Error("GitHub 502"));
    return Promise.resolve(`#${200 + n}`);
  });
  assert.deepEqual(result.published, [{ id: "um", ref: "#201" }]);
  assert.deepEqual(result.failed, { id: "dois", error: "GitHub 502" });
  assert.deepEqual(result.pending, ["tres"]);
  assert.equal(n, 2);
});
