import { test } from "node:test";
import assert from "node:assert/strict";
import { StallWatch } from "../src/stall.ts";

const MIN = 60_000;

test("saída parada abaixo do limite não avisa", () => {
  const w = new StallWatch();
  assert.equal(w.observe("t-1", "linha A", 0, 15 * MIN), false);
  assert.equal(w.observe("t-1", "linha A", 15 * MIN - 1, 15 * MIN), false);
});

test("saída parada até o limite avisa uma vez por episódio", () => {
  const w = new StallWatch();
  w.observe("t-1", "linha A", 0, 15 * MIN);
  assert.equal(w.observe("t-1", "linha A", 15 * MIN, 15 * MIN), true);
  assert.equal(w.observe("t-1", "linha A", 30 * MIN, 15 * MIN), false, "não repete o aviso");
});

test("qualquer saída nova reinicia a contagem e permite novo aviso", () => {
  const w = new StallWatch();
  w.observe("t-1", "A", 0, 10 * MIN);
  assert.equal(w.observe("t-1", "A", 10 * MIN, 10 * MIN), true);
  assert.equal(w.observe("t-1", "B", 11 * MIN, 10 * MIN), false, "saída mudou: zera");
  assert.equal(w.observe("t-1", "B", 20 * MIN, 10 * MIN), false, "ainda abaixo do limite após zerar");
  assert.equal(w.observe("t-1", "B", 21 * MIN, 10 * MIN), true, "novo episódio avisa de novo");
});

test("espaço do fim da saída não conta como mudança", () => {
  const w = new StallWatch();
  w.observe("t-1", "A\n", 0, 5 * MIN);
  assert.equal(w.observe("t-1", "A  ", 5 * MIN, 5 * MIN), true);
});

test("tarefas que não estão mais em execução são esquecidas", () => {
  const w = new StallWatch();
  w.observe("t-1", "A", 0, 5 * MIN);
  w.observe("t-2", "A", 0, 5 * MIN);
  w.prune(new Set(["t-2"]));
  assert.equal(w.observe("t-1", "A", 5 * MIN, 5 * MIN), false, "t-1 começou do zero");
  assert.equal(w.observe("t-2", "A", 5 * MIN, 5 * MIN), true);
});
