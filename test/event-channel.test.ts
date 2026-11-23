import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_POLICY, UI_ENTRY, emitEvent } from "../src/policy/event-policy.ts";

function fakeSink() {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    sink: {
      sendMessage: (msg: unknown, opts: unknown) => calls.push({ method: "sendMessage", args: [msg, opts] }),
      appendEntry: (type: string, data: unknown) => calls.push({ method: "appendEntry", args: [type, data] }),
    },
  };
}

const msg = { customType: "orch-event", content: "aviso", display: true };

test("evento rotineiro fica só na tela: não entra no contexto nem acorda a LLM", () => {
  const { sink, calls } = fakeSink();
  emitEvent(sink, EVENT_POLICY["orphan-worktrees"], msg);
  assert.deepEqual(calls, [{ method: "appendEntry", args: [UI_ENTRY, { content: "aviso" }] }]);
});

test("decisão entra no contexto e acorda a LLM", () => {
  const { sink, calls } = fakeSink();
  emitEvent(sink, EVENT_POLICY["worker-question"], msg);
  assert.deepEqual(calls, [{ method: "sendMessage", args: [msg, { triggerTurn: true }] }]);
});

test("conclusão entra no contexto e acorda a LLM para apresentar o resultado", () => {
  const { sink, calls } = fakeSink();
  emitEvent(sink, EVENT_POLICY["worker-done"], msg);
  assert.deepEqual(calls, [{ method: "sendMessage", args: [msg, { triggerTurn: true }] }]);
});

test("30 ciclos de avisos rotineiros: nenhum turno de LLM e nenhuma mensagem no contexto", () => {
  const { sink, calls } = fakeSink();
  for (let i = 0; i < 30; i++) emitEvent(sink, EVENT_POLICY["idle-candidates"], msg);
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 0);
  assert.equal(calls.length, 30);
});

const CHANNEL: Record<string, "tela" | "acorda"> = {
  "worker-question": "acorda",
  "worker-failed": "acorda",
  "worker-lost": "acorda",
  "launch-failed": "acorda",
  "send-failed": "acorda",
  "queue-failed": "acorda",
  "worker-done": "acorda",
  "pr-merged-no-plan": "acorda",
  "plan-completed": "acorda",
  "pending-replay": "acorda",
  "ci-action-sent": "tela",
  "plan-launched": "tela",
  "plan-transition": "tela",
  "idle-candidates": "tela",
  "worker-stalled": "tela",
  "herdr-check-failed": "tela",
  "orphan-worktrees": "tela",
  "readonly-session": "tela",
};

test("tabela da política: todo tipo de evento tem canal explícito, e rotineiros nunca vão ao contexto", () => {
  assert.deepEqual(Object.keys(CHANNEL).sort(), Object.keys(EVENT_POLICY).sort());
  for (const [kind, expected] of Object.entries(CHANNEL)) {
    const { sink, calls } = fakeSink();
    emitEvent(sink, EVENT_POLICY[kind as keyof typeof EVENT_POLICY], msg);
    const methods = calls.map((c) => c.method);
    if (expected === "tela") assert.deepEqual(methods, ["appendEntry"], kind);
    else assert.deepEqual(methods, ["sendMessage"], kind);
    if (expected === "acorda") assert.deepEqual(calls[0]?.args[1], { triggerTurn: true }, kind);
  }
});
