import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PrActionWatch,
  ciInstruction,
  conflictInstruction,
  failingChecks,
  isPrWatched,
  prUrlOf,
  prVerdict,
} from "../src/orchestrator/pr-watch.ts";
import type { PrState } from "../src/shared/prs.ts";

const pr = (over: Partial<PrState>): PrState => ({
  number: 171,
  state: "OPEN",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefOid: "abc",
  checks: [],
  ...over,
});

test("PR mergeada vence conflito: fecha, não aciona worker", () => {
  assert.equal(prVerdict(pr({ state: "MERGED", mergeable: "CONFLICTING" })), "merged");
});

test("conflito por mergeable ou por DIRTY é conflito; PR limpa fica aberta", () => {
  assert.equal(prVerdict(pr({ mergeable: "CONFLICTING" })), "conflict");
  assert.equal(prVerdict(pr({ mergeStateStatus: "DIRTY" })), "conflict");
  assert.equal(prVerdict(pr({})), "open");
  assert.equal(
    prVerdict(pr({ mergeable: "UNKNOWN" })),
    "pending",
    "UNKNOWN não é conflito nem PR limpa: GitHub ainda calcula",
  );
});

test("aciona uma vez por cabeça de branch, depois de marcar o envio; push novo reabre o caso", () => {
  const w = new PrActionWatch();
  assert.equal(w.shouldAct("t-1", "abc", true, "conflict"), true);
  w.markActed("t-1", "abc", "conflict");
  assert.equal(w.shouldAct("t-1", "abc", true, "conflict"), false, "mesmo commit não repete");
  assert.equal(w.shouldAct("t-1", "def", true, "conflict"), true, "commit novo ainda em conflito reabre");
});

test("envio que falhou não marca o head: a próxima consulta tenta de novo", () => {
  const w = new PrActionWatch();
  assert.equal(w.shouldAct("t-1", "abc", true, "ci"), true);
  assert.equal(w.shouldAct("t-1", "abc", true, "ci"), true, "sem markActed, ainda não acionado");
});

test("sair do problema zera só o seu tipo; voltar a ele aciona de novo", () => {
  const w = new PrActionWatch();
  w.markActed("t-1", "abc", "ci");
  w.markActed("t-1", "abc", "conflict");
  assert.equal(w.shouldAct("t-1", "abc", false, "ci"), false);
  assert.equal(w.shouldAct("t-1", "abc", true, "ci"), true, "CI voltou a falhar");
  assert.equal(w.shouldAct("t-1", "abc", true, "conflict"), false, "conflito segue acionado: não foi zerado");
});

test("checks falhando são os que concluíram com falha; pendente e sucesso não contam", () => {
  const s = pr({
    checks: [
      { name: "test", conclusion: "FAILURE", status: "COMPLETED" },
      { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      { name: "e2e", conclusion: null, status: "IN_PROGRESS" },
      { name: "test", conclusion: "FAILURE", status: "COMPLETED" },
      { name: "build", conclusion: "TIMED_OUT", status: "COMPLETED" },
    ],
  });
  assert.deepEqual(failingChecks(s), ["test", "build"]);
  assert.deepEqual(failingChecks(pr({ checks: [{ name: "x", conclusion: "SUCCESS", status: "COMPLETED" }] })), []);
});

test("instrução de CI nomeia os checks e proíbe force-push", () => {
  const text = ciInstruction("https://github.com/o/r/pull/171", ["test", "build"]);
  assert.match(text, /test, build/);
  assert.match(text, /gh run view/);
  assert.match(text, /não edite por palpite/);
  assert.match(text, /Não reescreva histórico/);
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
  assert.equal(
    isPrWatched({ ...base, notified: false }),
    false,
    "relatório não entregue: fechar/enviar marcaria como visto",
  );
  assert.equal(isPrWatched({ ...base, status: "running" }), false);
  assert.equal(isPrWatched({ ...base, tab_id: "" }), false);
});

test("PR da tarefa: a fonte se for PR, senão a PR entre os artefatos (tarefa de issue)", () => {
  const pr172 = "https://github.com/MarcosPTProenca/adaptative-learning/pull/172";
  assert.equal(prUrlOf({ source: pr172, artifacts: [] }), pr172);
  assert.equal(prUrlOf({ source: "https://github.com/o/r/issues/118", artifacts: ["/tmp/x", pr172] }), pr172);
  assert.equal(prUrlOf({ source: "https://github.com/o/r/issues/118", artifacts: ["http://127.0.0.1:5173/"] }), null);
  assert.equal(prUrlOf({ source: null }), null);
});

test("tarefa de issue com PR nos artefatos é acompanhada depois de entregue", () => {
  const base = { status: "done" as const, notified: true, tab_id: "t1" };
  assert.equal(
    isPrWatched({
      ...base,
      source: "https://github.com/o/r/issues/118",
      artifacts: ["https://github.com/o/r/pull/172"],
    }),
    true,
  );
  assert.equal(isPrWatched({ ...base, source: "https://github.com/o/r/issues/118", artifacts: [] }), false);
});

test("com várias PRs nos artefatos, prefere a do mesmo repositório da issue", () => {
  const outra = "https://github.com/o/outro/pull/5";
  const mesma = "https://github.com/o/r/pull/172";
  assert.equal(prUrlOf({ source: "https://github.com/o/r/issues/118", artifacts: [outra, mesma] }), mesma);
  assert.equal(
    prUrlOf({ source: "https://github.com/o/r/issues/118", artifacts: [outra] }),
    outra,
    "sem PR do mesmo repo, usa a primeira",
  );
});
