import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeUsage } from "../src/usage-report.ts";
import { newUsage, type Usage } from "../src/usage.ts";

const u = (over: Partial<Usage>): Usage => ({ ...newUsage(), ...over });

test("sem tarefas com uso: totais zerados e nenhuma taxa de cache inventada", () => {
  const s = summarizeUsage([{ model: "m", usage: null }]);
  assert.equal(s.tasks_with_usage, 0);
  assert.equal(s.tasks_without_usage, 1);
  assert.equal(s.cache_hit_ratio, null);
});

test("taxa de cache usa input + cacheRead + cacheWrite como denominador", () => {
  const s = summarizeUsage([
    { model: "m", usage: u({ input: 100, cacheRead: 300, cacheWrite: 100, totalTokens: 500 }) },
  ]);
  assert.equal(s.cache_hit_ratio, 300 / 500);
});

test("cache zero com entrada não cacheada dá taxa zero, não nula", () => {
  const s = summarizeUsage([{ model: "m", usage: u({ input: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 60 }) }]);
  assert.equal(s.cache_hit_ratio, 0);
});

test("agrega por modelo e separa custo informado de custo estimado", () => {
  const s = summarizeUsage([
    { model: "a", usage: u({ input: 10, output: 5, totalTokens: 15, cost: 0.2, costFromProvider: true }) },
    { model: "a", usage: u({ input: 10, output: 5, totalTokens: 15, cost: 0.1, costFromProvider: false }) },
    { model: "b", usage: u({ input: 1, totalTokens: 1, cost: 0.05, costFromProvider: true }) },
    { model: null, usage: u({ totalTokens: 2 }) },
  ]);
  assert.equal(s.tasks_with_usage, 4);
  assert.equal(s.totals.totalTokens, 33);
  assert.equal(Number(s.cost_reported_by_provider.toFixed(2)), 0.25);
  assert.equal(Number(s.cost_estimated.toFixed(2)), 0.1);
  assert.equal(s.by_model.a.tasks, 2);
  assert.equal(s.by_model.a.totalTokens, 30);
  assert.equal(s.by_model["<sem modelo>"].tasks, 1);
});

test("campos ausentes contam como zero e não quebram a soma", () => {
  const s = summarizeUsage([
    { model: "m", usage: u({}) },
    { model: "m", usage: undefined },
  ]);
  assert.equal(s.tasks_with_usage, 1);
  assert.equal(s.tasks_without_usage, 1);
  assert.equal(s.totals.totalTokens, 0);
});
