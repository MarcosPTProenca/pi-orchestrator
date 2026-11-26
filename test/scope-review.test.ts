import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore, launchable, type PlanDelegate } from "../src/orchestrator/plans.ts";
import { parseScopeVerdict, scopeReviewText, scopeStep } from "../src/orchestrator/scope.ts";

const T = "t-0000000a";
const delegate: PlanDelegate = {
  project_path: "/repo/proj",
  request: "fazer X",
  objective: "X funciona",
  mode: "direct-pr",
};

function twoDependentItems(): { store: PlanStore; planId: string } {
  const store = new PlanStore(mkdtempSync(join(tmpdir(), "scope-plan-")), () => "2026-11-26T00:00:00.000Z");
  store.create("p", "Plano", [
    { title: "primeiro", delegate },
    { title: "segundo", depends_on: ["1"], delegate: { ...delegate, request: "fazer Y" } },
  ]);
  store.act("p", "approve");
  return { store, planId: "p" };
}

test("plano com dois itens dependentes: o segundo só é lançado depois do parecer alinhado do primeiro", () => {
  const { store, planId } = twoDependentItems();
  assert.deepEqual(
    launchable(store.show(planId)).map((i) => i.id),
    ["1"],
  );

  store.launched(planId, "1", T);
  assert.deepEqual(launchable(store.show(planId)), []);

  const first = store.show(planId).items[0];
  assert.equal(scopeStep(first.scope, { verdict: "approved", reason: "ok" }).action, "request");
  store.requestScope(planId, "1");
  assert.equal(scopeStep(store.show(planId).items[0].scope, { verdict: "approved", reason: "ok" }).action, "wait");
  assert.deepEqual(launchable(store.show(planId)), [], "sem parecer, o segundo não é lançado");

  assert.equal(store.recordScope(T, "aligned", "entrega bate com a spec").length, 1);
  const aligned = store.show(planId).items[0];
  assert.equal(scopeStep(aligned.scope, { verdict: "approved", reason: "ok" }).action, "advance");
  assert.equal(store.markTaskDone(T).length, 1);
  assert.deepEqual(
    launchable(store.show(planId)).map((i) => i.id),
    ["2"],
  );
});

test("parecer fora do escopo bloqueia o primeiro e o segundo nunca é lançado", () => {
  const { store, planId } = twoDependentItems();
  store.launched(planId, "1", T);
  store.requestScope(planId, "1");
  store.recordScope(T, "out_of_scope", "entregou cache que a visão exclui");

  const item = store.show(planId).items[0];
  const step = scopeStep(item.scope, { verdict: "approved", reason: "ok" });
  assert.equal(step.action, "block");
  if (step.action !== "block") return;
  assert.match(step.reason, /fora do escopo: entregou cache/);

  store.blocked(planId, "1", step.reason);
  assert.deepEqual(launchable(store.show(planId)), []);
  assert.equal(store.show(planId).items[0].status, "blocked");
  assert.equal(store.show(planId).items[1].status, "pending");
});

test("veredito unverified também bloqueia, com a razão, para o usuário decidir", () => {
  const scope = { verdict: "unverified" as const, reason: "revisor sem acesso ao diff", requested_at: "t" };
  const step = scopeStep(scope, { verdict: "approved", reason: "ok" });
  assert.equal(step.action, "block");
  if (step.action === "block") assert.match(step.reason, /não conseguiu conferir: revisor sem acesso/);
});

test("sem verificação ainda, espera; verificação rejeitada ou não conferida segue como antes, sem revisão", () => {
  assert.equal(scopeStep(null, undefined).action, "wait");
  assert.equal(scopeStep(null, null).action, "wait");
  assert.equal(scopeStep(null, { verdict: "not_applicable", reason: "" }).action, "request");
  assert.equal(scopeStep(null, { verdict: "approved", reason: "" }).action, "request");
  assert.equal(scopeStep(null, { verdict: "rejected", reason: "" }).action, "advance");
  assert.equal(scopeStep(null, { verdict: "unverified", reason: "" }).action, "advance");
});

test("recordScope só grava em item que aguarda revisão e não mexe em item de outra tarefa", () => {
  const { store, planId } = twoDependentItems();
  store.launched(planId, "1", T);
  assert.deepEqual(store.recordScope(T, "aligned", "ok"), [], "sem revisão pendente não grava");
  store.requestScope(planId, "1");
  assert.deepEqual(store.recordScope("t-0000000b", "aligned", "ok"), [], "outra tarefa não casa");
  assert.equal(store.show(planId).items[0].scope?.verdict, "pending");
});

test("requestScope recusa item sem tarefa em execução", () => {
  const { store, planId } = twoDependentItems();
  assert.throws(() => store.requestScope(planId, "1"), /não está em execução com tarefa/);
});

test("parseScopeVerdict aceita JSON puro ou com cerca de código e recusa o resto", () => {
  assert.deepEqual(parseScopeVerdict('{"verdict":"aligned","reason":"bate"}'), {
    verdict: "aligned",
    reason: "bate",
  });
  assert.deepEqual(parseScopeVerdict('```json\n{"verdict":"out_of_scope","reason":"fora"}\n```'), {
    verdict: "out_of_scope",
    reason: "fora",
  });
  assert.throws(() => parseScopeVerdict("talvez"), /precisa ser JSON/);
  assert.throws(() => parseScopeVerdict('{"verdict":"ok","reason":"x"}'), /verdict inválido/);
  assert.throws(() => parseScopeVerdict('{"verdict":"aligned","reason":" "}'), /reason obrigatório/);
});

test("o contrato da revisão leva a VISION inteira e pede o JSON e a tool de parecer", () => {
  const vision = { status: "present" as const, content: "# Visão\nSó planilha de evals." };
  const text = scopeReviewText({
    taskId: T,
    planId: "p",
    itemId: "1",
    itemTitle: "primeiro",
    projectLabel: "proj",
    projectPath: "/repo/proj",
    request: "fazer X",
    objective: "X funciona",
    source: "https://github.com/o/r/issues/9",
    branch: "feat/x",
    artifacts: ["abc1234"],
    vision,
  });
  assert.ok(text.includes("Só planilha de evals."));
  assert.ok(text.includes("subagent `oracle` com contexto limpo"));
  assert.ok(text.includes(`orch_scope_verdict(task_id="${T}"`));
  assert.ok(text.includes("https://github.com/o/r/issues/9"));
});
