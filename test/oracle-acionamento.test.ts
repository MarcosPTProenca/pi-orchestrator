import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ORCHESTRATOR_ROLE } from "../src/orchestrator/prompts.ts";
import { scopeReviewText } from "../src/orchestrator/scope.ts";
import { registerOrchestratorTools, type OrchestratorToolContext } from "../src/orchestrator/tools.ts";

// keep: issue #243 (coordenação de issues já definidas não aciona o Oracle); issue #256: o Oracle atua só em spec e tickets. Dúvida operacional e revisão de escopo são do orquestrador.

test("papel separa coordenação operacional de issues já definidas da revisão de spec (#243)", () => {
  assert.match(ORCHESTRATOR_ROLE, /Coordenação operacional de issues já definidas/);
  assert.match(ORCHESTRATOR_ROLE, /não aciona o subagent `oracle-ro`/);
});

test("papel mantém a revisão do Oracle nas etapas de spec e tickets (#243)", () => {
  assert.match(ORCHESTRATOR_ROLE, /`grill-with-docs`, `to-spec` e `to-tickets`[^\n]*rode o subagent `oracle-ro`/);
  assert.match(ORCHESTRATOR_ROLE, /O Oracle entra só na revisão de spec e tickets\./);
});

test("papel: nenhuma menção ao Oracle cita pergunta operacional ou revisão de escopo (#256)", () => {
  const linhas = ORCHESTRATOR_ROLE.split("\n").filter((l) => /oracle/i.test(l));
  assert.ok(linhas.length > 0);
  for (const l of linhas) assert.doesNotMatch(l, /pergunta operacional|revisão de escopo|item concluído/i, l);
});

test("papel: o orquestrador responde dúvida operacional e avalia entregas, como complemento à verificação (#256)", () => {
  assert.match(ORCHESTRATOR_ROLE, /Dúvida operacional de worker você responde diretamente/);
  assert.match(ORCHESTRATOR_ROLE, /complementa a verificação determinística e não a substitui/);
});

test("revisão de escopo é do orquestrador: avalia sem subagent e grava com orch_scope_verdict (#256)", () => {
  const scope = scopeReviewText({
    taskId: "t-1",
    planId: "pl",
    itemId: "1",
    itemTitle: "item",
    projectLabel: "p",
    projectPath: "/tmp/p",
    request: "r",
    objective: "o",
    source: null,
    branch: null,
    artifacts: [],
    vision: { status: "missing" },
  });
  assert.doesNotMatch(scope, /oracle/i);
  assert.match(scope, /Avalie você mesmo, sem subagent/);
  assert.match(scope, /complementa a verificação determinística e não a substitui/);
  assert.match(scope, /orch_scope_verdict\(task_id="t-1", raw=<seu JSON>\)/);
});

test("tools: orch_scope_verdict segue registrada e orch_ask_verdict sai, sem outro uso (#256)", () => {
  const names: string[] = [];
  const pi = {
    registerTool(t: { name: string }) {
      names.push(t.name);
    },
  } as unknown as ExtensionAPI;
  registerOrchestratorTools(pi, {} as OrchestratorToolContext);
  assert.ok(names.includes("orch_scope_verdict"));
  assert.ok(!names.includes("orch_ask_verdict"));
});
