import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIALOGUE_BUDGET_DEFAULT,
  judgeAsk,
  newDialogue,
  normalize,
  recordAsk,
  resolveDialogueBudget,
  stopSummary,
} from "../src/shared/dialogue.ts";

const ask = (question: string, context = "encontrei dois helpers") => ({ question, context });

test("normalize ignora caixa, acento, pontuação e espaços repetidos", () => {
  assert.equal(normalize("  Reutilizar  qual contrato? "), normalize("reutilizar qual contrato"));
  assert.equal(normalize("Ação"), normalize("acao"));
});

test("primeira pergunta é progresso e consome orçamento ao ser entregue", () => {
  const d = newDialogue(3);
  const verdict = judgeAsk(d, ask("Qual helper usar?"));
  assert.equal(verdict, "progress");
  const next = recordAsk(d, ask("Qual helper usar?"), verdict);
  assert.equal(next.spent, 1);
  assert.equal(next.asks.length, 1);
});

test("mesma pergunta com contexto novo é progresso", () => {
  const d = recordAsk(newDialogue(3), ask("Qual helper usar?", "contexto A"), "progress");
  assert.equal(judgeAsk(d, ask("Qual helper usar?", "contexto B")), "progress");
});

test("mesma pergunta com o mesmo contexto, sem estratégia redirecionada, é redirect uma vez", () => {
  const d = recordAsk(newDialogue(3), ask("Qual helper usar?"), "progress");
  const verdict = judgeAsk(d, ask("qual helper usar"));
  assert.equal(verdict, "redirect");
  const next = recordAsk(d, ask("qual helper usar"), verdict);
  assert.equal(next.redirected, true);
  assert.equal(next.spent, 2, "redirect é entregue, então consome orçamento");
});

test("repetição sem evidência depois do redirect vira no_progress e não consome orçamento", () => {
  let d = recordAsk(newDialogue(3), ask("Qual helper usar?"), "progress");
  d = recordAsk(d, ask("Qual helper usar?"), "redirect");
  const verdict = judgeAsk(d, ask("Qual helper usar?"));
  assert.equal(verdict, "no_progress");
  const next = recordAsk(d, ask("Qual helper usar?"), verdict);
  assert.equal(next.spent, d.spent, "pergunta parada não é entregue");
});

test("orçamento esgotado vira exhausted mesmo para pergunta nova", () => {
  let d = newDialogue(2);
  d = recordAsk(d, ask("pergunta um"), "progress");
  d = recordAsk(d, ask("pergunta dois"), "progress");
  assert.equal(judgeAsk(d, ask("pergunta tres")), "exhausted");
});

test("orçamento padrão é 3 e o número de perguntas do worker não reduz o padrão", () => {
  assert.equal(DIALOGUE_BUDGET_DEFAULT, 3);
  assert.equal(newDialogue(DIALOGUE_BUDGET_DEFAULT).budget, 3);
});

test("resolveDialogueBudget: explícito vence o ambiente; sem nada usa o padrão", () => {
  assert.equal(resolveDialogueBudget(undefined, undefined), 3);
  assert.equal(resolveDialogueBudget(undefined, "5"), 5);
  assert.equal(resolveDialogueBudget(2, "5"), 2);
});

test("resolveDialogueBudget: ambiente inválido cai no padrão, mas valor explícito inválido é recusado", () => {
  assert.equal(resolveDialogueBudget(undefined, "abc"), 3);
  assert.equal(resolveDialogueBudget(undefined, "0"), 3);
  assert.equal(resolveDialogueBudget(undefined, "99"), 3);
  assert.throws(() => resolveDialogueBudget(0, undefined), /dialogue_budget/);
  assert.throws(() => resolveDialogueBudget(11, undefined), /dialogue_budget/);
  assert.throws(() => resolveDialogueBudget(2.5, undefined), /dialogue_budget/);
});

test("stopSummary traz tentativas, orçamento restante e a decisão concreta", () => {
  let d = recordAsk(newDialogue(3), ask("Qual helper usar?"), "progress");
  d = recordAsk(d, ask("Qual helper usar?"), "redirect");
  const text = stopSummary(d, ask("Qual helper usar?"), "no_progress");
  assert.match(text, /sem evidência nova/);
  assert.match(text, /2\/3/, "mostra gasto sobre orçamento");
  assert.match(text, /Qual helper usar\?/, "a pergunta concreta aparece");
  assert.match(text, /Decisão necessária/);
});
