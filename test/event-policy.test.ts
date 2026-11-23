import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_POLICY, statusKind, wakesLlm } from "../src/event-policy.ts";

test("evento de rotina nunca acorda o LLM", () => {
  assert.equal(wakesLlm("routine"), false);
});

test("decisão e conclusão acordam o LLM", () => {
  assert.equal(wakesLlm("decision"), true);
  assert.equal(wakesLlm("conclusion"), true);
});

test("pergunta, falha, perda e erro de lançamento são decisão", () => {
  for (const name of [
    "worker-question",
    "worker-failed",
    "worker-lost",
    "launch-failed",
    "send-failed",
    "queue-failed",
  ] as const) {
    assert.equal(EVENT_POLICY[name], "decision", name);
  }
});

test("transições rotineiras de plano, ociosas, paradas e ações já tomadas não acordam o LLM", () => {
  for (const name of [
    "ci-action-sent",
    "plan-launched",
    "plan-transition",
    "idle-candidates",
    "worker-stalled",
    "herdr-check-failed",
    "orphan-worktrees",
    "readonly-session",
  ] as const) {
    assert.equal(wakesLlm(EVENT_POLICY[name]), false, name);
  }
});

test("status de tarefa vira conclusão só quando done", () => {
  assert.equal(statusKind("done"), "conclusion");
  for (const status of ["blocked", "failed", "lost", "timeout"]) assert.equal(statusKind(status), "decision", status);
});

test("nenhum envio fixa triggerTurn em código: todo ponto lê a tabela", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /triggerTurn: (true|false)\b/);
});
