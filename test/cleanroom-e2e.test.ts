import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { approveSpec, checkSpec, renderSpec, reviewSpec, verifySpec } from "../src/shared/spec.ts";
import { checkTickets, proposeTickets, publishTickets, type TicketDraft } from "../src/shared/ticket-gate.ts";
import { PlanStore } from "../src/orchestrator/plans.ts";
import { createPlanFromTickets } from "../src/orchestrator/ticket-plan.ts";
import { editBlockReason } from "../src/shared/plan.ts";
import { parseManifest, runDoctor, bootstrap, type Probe, type Runner } from "../scripts/setup-lib.ts";
import { aggregate, runDelivery, type RunResult, type Scenario } from "../evals/pipeline/engine.ts";
import { summarizeTurns } from "../src/shared/usage.ts";
import * as S from "../evals/pipeline/scenarios.ts";

const ROOT = join(import.meta.dirname, "..");
const CLOCK = "2026-11-25T12:00:00.000Z";
const PROJECT = "/fake/projeto";
const TARGET = {
  project_path: PROJECT,
  mode: "direct-pr" as const,
  role: "worker",
  model: "claude-bridge/claude-haiku-5-5",
};
const tmp = (label: string): string => mkdtempSync(join(tmpdir(), `cleanroom-${label}-`));

const SPEC_BODY = `# Spec: fluxo cleanroom
## Problema
Pedido sem prova de fluxo ponta a ponta antes de merge.
## Comportamento
Atual: etapas isoladas. Esperado: cada etapa tem gate e evidência.
## Requisitos
- R1: spec só avança com revisão do Oracle e aprovação do usuário
- R2: tickets exigem test seams e cobertura de requisitos
- R3: merge exige review do head atual e autorização
## Cenários
- S1 (R1): Given spec revisada / When Oracle devolve ok / Then a spec pode ser aprovada
- S2 (R2): Given ticket sem test seams / When valido / Then o gate reporta missing_test_seams
- S3 (R3): Given review de head antigo / When tento mergear / Then o merge é recusado
## Non-goals
- Não rodar GitHub real nem token real.
## Invariantes
- Nenhum status approved sem aprovação do usuário.
## Validação
- npm test cobre S1, S2 e S3.
## Suposições
- Oracle é um serviço externo simulado no teste.
## Decisões pendentes
- nenhuma
`;

const DRAFT = renderSpec(SPEC_BODY, "draft");

function ticket(over: Partial<TicketDraft> & { id: string; parent: string }): TicketDraft {
  const { parent, ...rest } = over;
  return {
    title: `Comportamento ${rest.id}`,
    parent_fingerprint: parent,
    what: "resultado demoável ponta a ponta",
    requirements: ["R1"],
    scenarios: [{ id: `AC-${rest.id}`, given: "dado", when: "quando", then: "então" }],
    context: "",
    test_seams: ["gate puro"],
    non_goals: ["sem UI"],
    blocked_by: [],
    validation: ["npm test"],
    dod: ["testes verdes"],
    ...rest,
  };
}

const oracleOk = (): Promise<string> => Promise.resolve(JSON.stringify({ verdict: "ok", findings: [] }));
const oracleReject = (): Promise<string> =>
  Promise.resolve(
    JSON.stringify({
      verdict: "changes_required",
      findings: [{ severity: "contradiction", quote: "S3", message: "cenário contradiz R3" }],
    }),
  );

test("clone limpo: bootstrap só toca escopo do repo e não cria ~/.pi/agent", () => {
  const root = tmp("repo");
  const home = tmp("home");
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  mkdirSync(join(root, ".githooks"));
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  let hooksSet = false;
  const runner: Runner = {
    run(command, args, cwd) {
      calls.push({ command, args, cwd });
      if (args.includes("core.hooksPath") && args.includes("--get")) {
        return { status: 0, stdout: hooksSet ? ".githooks\n" : "" };
      }
      if (args.includes("core.hooksPath") && !args.includes("--get")) hooksSet = true;
      return { status: 0, stdout: "" };
    },
  };
  const first = bootstrap(root, runner, "22.22.1", "22.18.0");
  assert.deepEqual(
    first.map((s) => s.outcome),
    ["feito", "feito"],
  );
  const second = bootstrap(root, runner, "22.22.1", "22.18.0");
  assert.equal(second[0].outcome, "já estava");
  assert.equal(calls.filter((c) => c.command === "npm").length, 1);
  assert.ok(
    calls.every((c) => c.cwd === root),
    "todo comando roda no repo, não no HOME",
  );
  assert.equal(existsSync(join(home, ".pi")), false);
});

test("doctor em clone sem dependências diagnostica o que falta pelo perfil minimal", () => {
  const manifest = parseManifest(readFileSync(join(ROOT, "setup", "dependencies.json"), "utf8"));
  const home = tmp("doctor-home");
  const probe: Probe = {
    root: ROOT,
    home,
    nodeVersion: "22.22.1",
    platform: "linux",
    release: "fixture",
    env: {},
    run: () => null,
    read: () => undefined,
    exists: () => false,
  };
  const report = runDoctor(manifest, probe, "minimal");
  assert.ok(report.missing > 0, "clone sem ferramentas deve reportar ausências");
  assert.equal(report.results.find((r) => r.id === "node")?.status, "ready");
  assert.ok(
    report.results.some((r) => r.status === "missing" && r.fix.length > 0),
    "cada ausência obrigatória traz instrução de correção",
  );
});

test("spec: gate determinístico passa e Oracle ok libera revisão", async () => {
  assert.deepEqual(checkSpec(DRAFT, "feature"), []);
  const res = await reviewSpec(DRAFT, { risk: "feature", oracle: oracleOk });
  assert.equal(res.verdict, "ok");
  assert.equal(res.oracleCalls, 1);
});

test("reprovação pelo Oracle não vira aprovação e não permite approveSpec", async () => {
  const res = await reviewSpec(DRAFT, { risk: "feature", oracle: oracleReject });
  assert.equal(res.verdict, "changes_required");
  assert.ok(res.findings.some((f) => f.code === "oracle_contradiction"));
  assert.throws(() => approveSpec(res.markdown, "user"), /precisa estar reviewed/);
});

test("spec alterada depois da revisão perde o status e não aceita aprovação", () => {
  const reviewed = renderSpec(SPEC_BODY, "reviewed");
  const approved = approveSpec(reviewed, "user");
  assert.equal(verifySpec(approved).status, "approved");
  const edited = approved.replace("- Não rodar GitHub real", "- Rodar GitHub real");
  assert.equal(verifySpec(edited).stale, true);
  assert.equal(verifySpec(edited).status, "draft");
  assert.throws(() => approveSpec(edited, "user"), /precisa estar reviewed/);
});

test("aprovação de spec só existe para o usuário", () => {
  const reviewed = renderSpec(SPEC_BODY, "reviewed");
  assert.throws(() => approveSpec(reviewed, "agent" as "user"), /só do usuário/);
});

const APPROVED = approveSpec(renderSpec(SPEC_BODY, "reviewed"), "user");
const FP = verifySpec(APPROVED).fingerprint;
const TICKETS: TicketDraft[] = [
  ticket({ id: "fluxo-minimo", parent: FP, requirements: ["R1"], what: "spec aprovada gera tickets" }),
  ticket({
    id: "gate-seams",
    parent: FP,
    requirements: ["R2"],
    blocked_by: ["fluxo-minimo"],
    what: "gate bloqueia ticket sem seams",
  }),
  ticket({
    id: "merge-autorizado",
    parent: FP,
    requirements: ["R3"],
    blocked_by: ["gate-seams"],
    what: "merge só com review e autorização",
  }),
];

test("ticket sem test seams é bloqueado antes de virar issue", () => {
  const broken = TICKETS.map((t) => (t.id === "gate-seams" ? { ...t, test_seams: [] } : t));
  assert.ok(checkTickets(APPROVED, broken).some((f) => f.code === "missing_test_seams"));
  const proposal = proposeTickets(APPROVED, broken);
  assert.equal(proposal.status, "blocked");
  assert.deepEqual(proposal.issues, []);
});

test("tickets válidos são publicados em ordem de dependência, só após aprovação do usuário", async () => {
  await assert.rejects(
    publishTickets(APPROVED, TICKETS, "agent" as "user", () => Promise.resolve("x")),
    /exige aprovação do usuário/,
  );
  const published: string[] = [];
  const res = await publishTickets(APPROVED, TICKETS, "user", (issue) => {
    published.push(issue.id);
    return Promise.resolve(`#${published.length}`);
  });
  assert.deepEqual(published, ["fluxo-minimo", "gate-seams", "merge-autorizado"]);
  assert.equal(res.failed, null);
});

test("plano aprovado libera só o primeiro item; worker fica bloqueado sem PLAN_READY", () => {
  const store = new PlanStore(tmp("plans"), () => CLOCK);
  const plan = createPlanFromTickets(store, "plano-e2e", "Plano cleanroom", APPROVED, TICKETS, TARGET);
  assert.equal(plan.items.length, 3);
  assert.deepEqual(plan.items[1].depends_on, ["1"]);
  const approved = store.act("plano-e2e", "approve");
  assert.equal(approved.state, "approved");
  assert.deepEqual(
    store.ready(approved).map((i) => i.id),
    ["1"],
  );
  assert.equal(editBlockReason(null) !== null, true, "sem fase, edição é bloqueada");
  assert.equal(editBlockReason("PLAN_READY"), null, "PLAN_READY libera edição");
});

test("criação de plano recusa spec não aprovada com código e status", () => {
  const store = new PlanStore(tmp("plans-unapproved"), () => CLOCK);
  assert.throws(
    () => createPlanFromTickets(store, "unapproved", "Plano", DRAFT, TICKETS, TARGET),
    /spec_not_approved.*draft/,
  );
  assert.deepEqual(store.list(), []);
});

test("criação de plano recusa fatia horizontal com código e ticket", () => {
  const store = new PlanStore(tmp("plans-horizontal"), () => CLOCK);
  const horizontal = TICKETS.map((t, i) => (i === 0 ? { ...t, title: "Criar tabela de tickets" } : t));
  assert.throws(
    () => createPlanFromTickets(store, "horizontal", "Plano", APPROVED, horizontal, TARGET),
    /horizontal_slice.*fluxo-minimo/,
  );
  assert.deepEqual(store.list(), []);
});

test("criação de plano recusa ciclo no DAG com código e caminho", () => {
  const store = new PlanStore(tmp("plans-cycle"), () => CLOCK);
  const cyclic = TICKETS.map((t, i) => (i === 0 ? { ...t, blocked_by: ["merge-autorizado"] } : t));
  assert.throws(
    () => createPlanFromTickets(store, "cycle", "Plano", APPROVED, cyclic, TARGET),
    /dependency_cycle.*fluxo-minimo.*merge-autorizado/,
  );
  assert.deepEqual(store.list(), []);
});

test("criação de plano recusa requisito sem cobertura com código e requisito", () => {
  const store = new PlanStore(tmp("plans-uncovered"), () => CLOCK);
  const uncovered = TICKETS.map((t, i) => (i === 0 ? { ...t, requirements: ["R99"] } : t));
  assert.throws(
    () => createPlanFromTickets(store, "uncovered", "Plano", APPROVED, uncovered, TARGET),
    /uncovered_requirement.*R1/,
  );
  assert.deepEqual(store.list(), []);
});

const byId = (id: string): Scenario => S.ALL_SCENARIOS.find((s) => s.id === id) as Scenario;
const run = (sc: Scenario): Promise<RunResult> => runDelivery(sc, tmp("delivery"));

test("caminho feliz: PR aberta, review aprovado no head, merge confirmado e próxima etapa liberada", async () => {
  const r = await run(byId("bug-tdd"));
  assert.deepEqual(r.transitions.slice(0, 2), ["pr_open@0001", "review_pending@0001"]);
  assert.equal(r.terminal, "merged");
  const approvedHeads = r.reviews.filter((x) => x.verdict === "approve").map((x) => x.head);
  assert.equal(r.github.mergeCalls.length, 1);
  assert.deepEqual(approvedHeads, [r.github.mergeCalls[0][r.github.mergeCalls[0].indexOf("--match-head-commit") + 1]]);

  const next = await run(S.PLAN_A_TO_B);
  assert.equal(next.terminal, "merged");
  assert.deepEqual(next.ready_per_tick[1], ["2"], "item B só libera após merge confirmado");
});

test("reprovação do review: fix loop gera novo SHA e só o head corrigido é aprovado e mergeado", async () => {
  const r = await run(byId("review-defect-fixed"));
  assert.deepEqual(r.reviews, [
    { head: r.heads[0], verdict: "request_changes" },
    { head: r.heads[1], verdict: "approve" },
  ]);
  assert.equal(r.github.mergeCalls.length, 1);
  assert.ok(r.github.mergeCalls[0].includes(r.heads[1]), "merge usa o SHA corrigido");
});

test("CI vermelho corrigido: merge só depois do CI verde no head novo", async () => {
  const r = await run(byId("ci-bug-fixed"));
  assert.deepEqual(
    r.ci.map((c) => c.conclusion),
    ["FAILURE", "SUCCESS"],
  );
  assert.equal(r.terminal, "merged");
});

test("reviewer duplicado ou aprovação repetida não gera segundo merge", async () => {
  const r = await run(byId("duplicate-approval"));
  assert.equal(r.github.mergeCalls.length, 1);
  assert.equal(r.terminal, "merged");
});

test("L2 (dependência) e L3 (CI/permissões) exigem aprovação humana, sem merge", async () => {
  for (const id of ["l2-manual", "l3-manual"]) {
    const r = await run(byId(id));
    assert.equal(r.github.mergeCalls.length, 0, id);
    assert.ok(r.integrations[0].codes.includes("risk_requires_human"), id);
  }
});

test("sem autorização do usuário o merge não acontece", async () => {
  const r = await run(byId("no-authorization"));
  assert.equal(r.github.mergeCalls.length, 0);
  assert.ok(r.integrations[0].codes.includes("no_merge_authorization"));
});

test("mudança de escopo fora do ticket bloqueia o merge", async () => {
  const r = await run(byId("scope-drift"));
  assert.equal(r.github.mergeCalls.length, 0);
  assert.ok(r.integrations[0].codes.includes("scope_drift"));
});

test("agregado do conjunto: zero merges indevidos e métricas nativas por cenário", async () => {
  const results: RunResult[] = [];
  for (const sc of S.ALL_SCENARIOS) results.push(await run(sc));
  const m = aggregate(results);
  assert.equal(m.improper_merges, 0);
  assert.equal(m.missed_merges, 0);
  assert.equal(m.scenarios, S.ALL_SCENARIOS.length);
  const perScenario = results.map((r) => ({ id: r.id, ...summarizeTurns(r.turns) }));
  assert.ok(
    perScenario.every((p) => p.turns > 0),
    "cada cenário registra turnos",
  );
  const total = perScenario.reduce((s, p) => s + p.cost, 0);
  assert.ok(Math.abs(total - m.cost_simulated) < 1e-9, "custo por cenário soma no agregado");
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

test("review.ts e merge-gate.ts têm caller real em src (não ficam órfãos)", () => {
  const files = sourceFiles(join(ROOT, "src"));
  for (const mod of ["review.ts", "merge-gate.ts"]) {
    const callers = files.filter((f) => !f.endsWith(`/${mod}`) && readFileSync(f, "utf8").includes(`/${mod}"`));
    assert.ok(callers.length > 0, `${mod} sem caller em src: ${relative(ROOT, join(ROOT, "src"))} precisa importá-lo`);
  }
});

test("fixtures e harness não contêm padrões de token real", () => {
  const SECRET = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/;
  const dirs = ["test", "evals", "src", "scripts", "setup"];
  const hits = dirs.flatMap((d) => sourceFiles(join(ROOT, d)).filter((f) => SECRET.test(readFileSync(f, "utf8"))));
  assert.deepEqual(hits, []);
});
