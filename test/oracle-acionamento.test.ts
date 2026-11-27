import assert from "node:assert/strict";
import { test } from "node:test";
import { ORCHESTRATOR_ROLE } from "../src/orchestrator/prompts.ts";
import { askMessageFor } from "../src/orchestrator/messages.ts";
import { scopeReviewText } from "../src/orchestrator/scope.ts";
import type { WatchEvent } from "../src/shared/task.ts";

// keep: issue #243 (Oracle em plano operacional): coordenação de issues já definidas não aciona o Oracle; spec e tickets seguem com revisão.

test("papel separa coordenação operacional de issues já definidas da revisão de spec (#243)", () => {
  assert.match(ORCHESTRATOR_ROLE, /Coordenação operacional de issues já definidas/);
  assert.match(ORCHESTRATOR_ROLE, /não aciona o subagent `oracle-ro`/);
});

test("papel mantém a revisão do Oracle nas etapas de spec e tickets (#243)", () => {
  assert.match(ORCHESTRATOR_ROLE, /`grill-with-docs`, `to-spec` e `to-tickets`[^\n]*rode o subagent `oracle-ro`/);
});

test("pontos de acionamento do Oracle continuam: pergunta de worker e revisão de escopo (#243)", () => {
  const ask = askMessageFor({
    task_id: "t-1",
    project_id: "p",
    status: "ask",
    question: "usar A ou B?",
    ask_id: "a1",
    result: null,
    artifacts: [],
  } as unknown as WatchEvent);
  assert.match(ask, /Rode o subagent `oracle-ro`/);
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
  assert.match(scope, /Rode o subagent `oracle-ro`/);
});
