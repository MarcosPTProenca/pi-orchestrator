import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_POLICY, UI_ENTRY, emitEvent } from "../src/event-policy.ts";

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
