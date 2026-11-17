import { test } from "node:test";
import assert from "node:assert/strict";
import { newUsage, addNewUsage } from "../src/usage.ts";

const asst = (ts: number, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  role: "assistant",
  timestamp: ts,
  usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite },
});

test("soma só mensagens que ainda não foram contadas (identificadas pelo timestamp)", () => {
  const first = addNewUsage(newUsage(), [{ role: "user" }, asst(1, 10, 5, 100, 20)], []);
  assert.equal(first.total.input, 10);
  const second = addNewUsage(first.total, [{ role: "user" }, asst(1, 10, 5, 100, 20), { role: "user" }, asst(2, 3, 2)], first.counted);
  assert.equal(second.total.input, 13);
  assert.equal(second.total.output, 7);
  assert.deepEqual(second.counted, [1, 2]);
});

test("nova sessão na mesma pasta conta as mensagens novas, não zera nem repete", () => {
  // Mesma tarefa, novo processo: a sessão traz de novo as mensagens antigas e uma nova.
  const r = addNewUsage(addNewUsage(newUsage(), [asst(1, 10, 5)], []).total, [asst(1, 10, 5), asst(9, 4, 1)], [1]);
  assert.equal(r.total.input, 14);
});

test("mensagem sem usage (ferramenta, erro) não quebra a soma", () => {
  const r = addNewUsage(newUsage(), [{ role: "toolResult" }, { role: "assistant", timestamp: 5 }, asst(6, 4, 1)], []);
  assert.equal(r.total.input, 4);
});

test("total de tokens inclui cache lido e escrito", () => {
  const r = addNewUsage(newUsage(), [asst(1, 2, 9, 35219, 33832)], []);
  assert.equal(r.total.totalTokens, 2 + 9 + 35219 + 33832);
});
