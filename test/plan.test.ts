import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toExecutionTicket, type ExecutionTicket, type TicketContext } from "../src/shared/execution-ticket.ts";
import {
  PLAN_FILE,
  persistPlan,
  readPhase,
  renderPlanMarkdown,
  reusablePlan,
  staleReason,
  ticketFingerprint,
  validatePlan,
  writePhase,
  type ImplementationPlan,
} from "../src/shared/plan.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  return dir;
}

function ctx(overrides: Partial<TicketContext> = {}): TicketContext {
  return {
    task_id: "t-plan",
    attempt_id: "a-1",
    report_path: "/tmp/report.json",
    base_sha: "abc123",
    head_sha: null,
    validation: { schema_version: 1, commands: ["npm test"], exceptions: [] },
    ...overrides,
  };
}

function ticketWith(overrides: Record<string, unknown> = {}, root = repo()): ExecutionTicket {
  return toExecutionTicket(
    {
      project_path: root,
      role: "impl",
      request: "Corrigir o bug X",
      objective: "Bug X corrigido",
      mode: "direct-pr",
      acceptance: ["Teste de regressão do bug X passa", "npm test verde"],
      ...overrides,
    },
    ctx(),
  );
}

function bugPlan(t: ExecutionTicket, overrides: Partial<ImplementationPlan> = {}): ImplementationPlan {
  return {
    schema_version: 1,
    task_id: t.task_id,
    attempt_id: t.attempt_id,
    ticket_fingerprint: ticketFingerprint(t),
    base_sha: t.origin.base_sha,
    head_sha: null,
    kind: "bug",
    problem: "X quebra quando o valor é igual ao limite",
    diagnosis: [{ ref: "src/a.ts:1", note: "comparação estrita onde o contrato pede inclusiva" }],
    approach: "Trocar < por <= na comparação de src/a.ts",
    rejected_alternatives: [{ option: "Reescrever o módulo", reason: "fora do escopo da issue" }],
    reproduction: "teste que falha com valor igual ao limite",
    test_seams: [],
    steps: [
      {
        id: "S1",
        action: "Adicionar teste de regressão no limite",
        files: ["test/a.test.ts"],
        verifies: ["AC-1"],
        check: "node --import tsx --test test/a.test.ts",
      },
      { id: "S2", action: "Trocar < por <=", files: ["src/a.ts"], verifies: ["AC-1", "AC-2"], check: "npm test" },
    ],
    criteria: [
      { id: "AC-1", covered_by: ["S1", "S2"], evidence: "teste de regressão verde" },
      { id: "AC-2", covered_by: ["S2"], evidence: "npm test sai com 0" },
    ],
    expected_tests: ["regressão no limite"],
    risks: [],
    deviations: [],
    blockers: [],
    ...overrides,
  };
}

function errorsOf(raw: unknown, t: ExecutionTicket, root: string): string[] {
  const r = validatePlan(raw, t, root);
  assert.equal(r.ok, false, "o plano deveria ser recusado");
  return r.ok ? [] : r.errors;
}

test("correção simples com regressão e critérios cobertos é aceita", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const r = validatePlan(bugPlan(t), t, root);
  assert.equal(r.ok, true, r.ok ? "" : r.errors.join("; "));
});

test("mudança multi-arquivo de feature exige test seams", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const feature = bugPlan(t, { kind: "feature", reproduction: null });
  assert.match(errorsOf(feature, t, root).join("\n"), /test_seams/);
  const ok = validatePlan(
    { ...feature, test_seams: [{ name: "fronteira de worker", boundary: "tool_call do worker" }] },
    t,
    root,
  );
  assert.equal(ok.ok, true);
});

test("feature multi-arquivo com diagnóstico em dois arquivos e test seams é aceita", () => {
  const root = repo();
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
  const t = ticketWith({}, root);
  const plan = bugPlan(t, {
    kind: "feature",
    reproduction: null,
    diagnosis: [
      { ref: "src/a.ts:1", note: "ponto de entrada" },
      { ref: "src/b.ts:1", note: "consumidor do contrato" },
    ],
    test_seams: [{ name: "entrada pública", boundary: "função exportada de src/a.ts" }],
  });
  const r = validatePlan(plan, t, root);
  assert.equal(r.ok, true, r.ok ? "" : r.errors.join("; "));
});

test("bug sem reprodução é recusado", () => {
  const root = repo();
  const t = ticketWith({}, root);
  assert.match(errorsOf(bugPlan(t, { reproduction: null }), t, root).join("\n"), /reprodução/);
});

test("plano vago ('testar tudo') reprova validação", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const vague = bugPlan(t);
  vague.steps[1] = { ...vague.steps[1], check: "testar tudo" };
  assert.match(errorsOf(vague, t, root).join("\n"), /check vago/);
});

test("critério de aceite sem passo previsto reprova validação", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const plan = bugPlan(t, { criteria: [{ id: "AC-1", covered_by: ["S1"], evidence: "teste verde" }] });
  assert.match(errorsOf(plan, t, root).join("\n"), /AC-2/);
});

test("diagnóstico que aponta arquivo inexistente reprova", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const plan = bugPlan(t, { diagnosis: [{ ref: "src/nao-existe.ts:10", note: "x" }] });
  assert.match(errorsOf(plan, t, root).join("\n"), /src\/nao-existe\.ts/);
});

test("desvio de escopo ou decisão de produto não vira plano: reporta blocked", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const plan = bugPlan(t, { deviations: ["Trocar o formato público do export: decisão de produto"] });
  assert.match(errorsOf(plan, t, root).join("\n"), /desvio/);
});

test("bloqueador pendente (issue ambígua) impede o plano pronto", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const plan = bugPlan(t, { blockers: ["não está claro se o limite é inclusivo na API v1"] });
  assert.match(errorsOf(plan, t, root).join("\n"), /bloqueador/);
});

test("ticket sem critérios verificáveis não recebe plano", () => {
  const root = repo();
  const t = toExecutionTicket(
    { project_path: root, role: "impl", request: "x", objective: "y", mode: "direct-pr" },
    ctx(),
  );
  assert.equal(t.status, "needs_clarification");
  assert.match(errorsOf(bugPlan(t), t, root).join("\n"), /ticket sem critérios/);
});

test("mudança de ticket invalida o plano com motivo ticket_changed", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const changed = ticketWith({ objective: "Outro objetivo" }, root);
  assert.equal(staleReason(bugPlan(t), changed), "ticket_changed");
});

test("mudança de base invalida o plano com motivo base_changed", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const moved = toExecutionTicket(
    {
      project_path: root,
      role: "impl",
      request: "Corrigir o bug X",
      objective: "Bug X corrigido",
      mode: "direct-pr",
      acceptance: ["Teste de regressão do bug X passa", "npm test verde"],
    },
    ctx({ base_sha: "def456" }),
  );
  assert.equal(staleReason(bugPlan(t), moved), "base_changed");
  assert.equal(staleReason(bugPlan(t), t), null);
});

test("retomar a mesma tarefa reutiliza o plano válido, sem refazer a análise", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const taskDir = mkdtempSync(join(tmpdir(), "task-"));
  persistPlan(taskDir, bugPlan(t));
  const r = reusablePlan(taskDir, t, root);
  assert.equal(r.reuse, true);
  assert.match(readFileSync(join(taskDir, "implementation-plan.md"), "utf8"), /Trocar < por <=/);
});

test("reload com plano inválido o põe de lado com motivo, sem reutilizar", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const taskDir = mkdtempSync(join(tmpdir(), "task-"));
  persistPlan(taskDir, bugPlan(t));
  const changed = ticketWith({ objective: "Outro objetivo" }, root);
  const r = reusablePlan(taskDir, changed, root);
  assert.equal(r.reuse, false);
  assert.match(r.reuse ? "" : r.reason, /ticket_changed/);
  assert.equal(
    readdirSync(taskDir).some((f) => f.startsWith("implementation-plan-invalid-")),
    true,
    "o plano antigo fica preservado para auditoria",
  );
  assert.equal(readdirSync(taskDir).includes(PLAN_FILE), false);
});

test("fase persiste e volta igual após reload", () => {
  const taskDir = mkdtempSync(join(tmpdir(), "task-"));
  assert.equal(readPhase(taskDir), null);
  writePhase(taskDir, { phase: "PLAN_READY", ticket_fingerprint: "abc" });
  assert.deepEqual(readPhase(taskDir), { phase: "PLAN_READY", ticket_fingerprint: "abc" });
});

test("markdown legível traz problema, diagnóstico, critérios e test seams", () => {
  const root = repo();
  const t = ticketWith({}, root);
  const md = renderPlanMarkdown({
    ...bugPlan(t),
    kind: "feature",
    reproduction: null,
    test_seams: [{ name: "fronteira", boundary: "tool_call" }],
  });
  for (const s of ["## Problema", "src/a.ts:1", "## Critérios", "AC-1", "## Test seams", "tool_call"]) {
    assert.match(md, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
