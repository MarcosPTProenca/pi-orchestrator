import { test } from "node:test";
import assert from "node:assert/strict";
import { newUsage, addNewUsage, cacheHitRatio } from "../src/usage.ts";

const asst = (ts: number, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  role: "assistant",
  timestamp: ts,
  usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite },
});

test("soma só mensagens que ainda não foram contadas (identificadas por resposta ou timestamp)", () => {
  const first = addNewUsage(newUsage(), [{ role: "user" }, asst(1, 10, 5, 100, 20)], []);
  assert.equal(first.total.input, 10);
  const second = addNewUsage(
    first.total,
    [{ role: "user" }, asst(1, 10, 5, 100, 20), { role: "user" }, asst(2, 3, 2)],
    first.counted,
  );
  assert.equal(second.total.input, 13);
  assert.equal(second.total.output, 7);
  assert.equal(second.counted.length, 2);
});

test("nova sessão na mesma pasta conta as mensagens novas, não zera nem repete", () => {
  const r = addNewUsage(addNewUsage(newUsage(), [asst(1, 10, 5)], []).total, [asst(1, 10, 5), asst(9, 4, 1)], [1]);
  assert.equal(r.total.input, 14);
});

test("dois turnos com o mesmo timestamp e responseId distintos contam ambos", () => {
  const a = { ...asst(7, 10, 1), responseId: "resp-a" };
  const b = { ...asst(7, 5, 1), responseId: "resp-b" };
  assert.equal(addNewUsage(newUsage(), [a, b], []).total.input, 15);
});

test("mesma resposta reentregue com outro timestamp (fork ou reload) não é contada de novo", () => {
  const first = addNewUsage(newUsage(), [{ ...asst(1, 10, 5), responseId: "resp-a" }], []);
  const again = addNewUsage(first.total, [{ ...asst(99, 10, 5), responseId: "resp-a" }], first.counted);
  assert.equal(again.total.input, 10);
});

test("usage.json legado (timestamp numérico) não recebe a mesma resposta de novo após o upgrade", () => {
  const legado = { total: { ...newUsage(), input: 10, totalTokens: 15 }, counted: [1] };
  const r = addNewUsage(legado.total, [{ ...asst(1, 10, 5), responseId: "resp-a" }], legado.counted);
  assert.equal(r.total.input, 10);
});

test("mensagem sem usage (ferramenta, erro) não quebra a soma", () => {
  const r = addNewUsage(newUsage(), [{ role: "toolResult" }, { role: "assistant", timestamp: 5 }, asst(6, 4, 1)], []);
  assert.equal(r.total.input, 4);
});

test("total de tokens inclui cache lido e escrito", () => {
  const r = addNewUsage(newUsage(), [asst(1, 2, 9, 35219, 33832)], []);
  assert.equal(r.total.totalTokens, 2 + 9 + 35219 + 33832);
});

const comCusto = (ts: number, total: number, fromProvider: boolean | undefined) => ({
  role: "assistant",
  timestamp: ts,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total, totalFromProvider: fromProvider },
  },
});

test("soma o custo informado e marca como reportado só se todas as parcelas vieram do provedor", () => {
  const r = addNewUsage(newUsage(), [comCusto(1, 0.5, true), comCusto(2, 0.25, true)], []);
  assert.equal(r.total.cost, 0.75);
  assert.equal(r.total.costFromProvider, true);
});

test("custo estimado pelo catálogo não é apresentado como custo reportado", () => {
  const r = addNewUsage(newUsage(), [comCusto(1, 0.5, true), comCusto(2, 0.25, false)], []);
  assert.equal(r.total.cost, 0.75);
  assert.equal(r.total.costFromProvider, false);
});

test("mensagem sem campo de custo conta tokens mas não inventa custo", () => {
  const r = addNewUsage(newUsage(), [asst(1, 10, 5)], []);
  assert.equal(r.total.cost, 0);
  assert.equal(r.total.costFromProvider, false);
});

test("usage.json antigo, sem campo de custo, continua somando", () => {
  const antigo = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
  const r = addNewUsage(antigo as ReturnType<typeof newUsage>, [asst(3, 1, 1)], [1]);
  assert.equal(r.total.input, 11);
  assert.equal(r.total.cost, 0);
});

test("taxa de acerto do cache: cacheRead / (input + cacheRead + cacheWrite)", () => {
  const u = addNewUsage(newUsage(), [asst(1, 20, 1, 80, 0)], []).total;
  assert.equal(cacheHitRatio(u), 0.8);
});

test("taxa de acerto do cache sem entrada devolve null, não zero", () => {
  assert.equal(cacheHitRatio(newUsage()), null);
});
