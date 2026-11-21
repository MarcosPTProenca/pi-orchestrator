import { test } from "node:test";
import assert from "node:assert/strict";
import { ConflictWatch, conflictInstruction, isPrWatched, prVerdict } from "../src/pr-watch.ts";
import type { PrState } from "../src/prs.ts";

const pr = (over: Partial<PrState>): PrState => ({
  number: 171, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "abc", checks: [], ...over,
});

test("PR mergeada vence conflito: fecha, não aciona worker", () => {
  assert.equal(prVerdict(pr({ state: "MERGED", mergeable: "CONFLICTING" })), "merged");
});

test("conflito por mergeable ou por DIRTY é conflito; PR limpa fica aberta", () => {
  assert.equal(prVerdict(pr({ mergeable: "CONFLICTING" })), "conflict");
  assert.equal(prVerdict(pr({ mergeStateStatus: "DIRTY" })), "conflict");
  assert.equal(prVerdict(pr({})), "open");
  assert.equal(prVerdict(pr({ mergeable: "UNKNOWN" })), "pending", "UNKNOWN não é conflito nem PR limpa: GitHub ainda calcula");
});

test("aciona uma vez por cabeça de branch; push novo reabre o caso", () => {
  const w = new ConflictWatch();
  assert.equal(w.shouldAct("t-1", "abc", true), true);
  assert.equal(w.shouldAct("t-1", "abc", true), false, "mesmo commit não repete");
  assert.equal(w.shouldAct("t-1", "def", true), true, "commit novo ainda em conflito reabre");
});

test("sair do conflito zera o caso; voltar a conflitar aciona de novo", () => {
  const w = new ConflictWatch();
  assert.equal(w.shouldAct("t-1", "abc", true), true);
  assert.equal(w.shouldAct("t-1", "abc", false), false);
  assert.equal(w.shouldAct("t-1", "abc", true), true);
});

test("instrução ao worker traz a PR, proíbe force-push e pede checks e push", () => {
  const text = conflictInstruction("https://github.com/MarcosPTProenca/adaptative-learning/pull/171");
  assert.match(text, /pull\/171/);
  assert.match(text, /Não reescreva histórico/);
  assert.match(text, /push/);
});

test("só acompanha tarefa concluída, já entregue ao usuário, com PR e aba", () => {
  const base = { status: "done", notified: true, source: "https://github.com/o/r/pull/1", tab_id: "t1" } as const;
  assert.equal(isPrWatched(base), true);
  assert.equal(isPrWatched({ ...base, notified: false }), false, "relatório não entregue: fechar/enviar marcaria como visto");
  assert.equal(isPrWatched({ ...base, status: "running" }), false);
  assert.equal(isPrWatched({ ...base, tab_id: "" }), false);
});
