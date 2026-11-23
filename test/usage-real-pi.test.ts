import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addNewUsage, newUsage, cacheHitRatio, type Usage } from "../src/shared/usage.ts";

const load = (name: string) => {
  const url = new URL(`./fixtures/usage-real-pi/${name}`, import.meta.url);
  return readFileSync(url, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type?: string; message?: Record<string, unknown> });
};

const assistants = (entries: ReturnType<typeof load>) =>
  entries
    .filter((e) => e.type === "message" && e.message?.role === "assistant")
    .map(
      (e) =>
        e.message as {
          role: string;
          responseId: string;
          timestamp: number;
          usage: Partial<Usage> & { cost?: { total?: number; totalFromProvider?: boolean } };
        },
    );

const principal = assistants(load("sessao-principal.jsonl"));
const fork = assistants(load("sessao-fork.jsonl"));

test("fixture real: sessão principal tem 4 respostas com responseId distinto", () => {
  assert.equal(principal.length, 4);
  assert.equal(new Set(principal.map((m) => m.responseId)).size, 4);
});

test("fixture real: o fork copia as respostas da origem com o mesmo responseId", () => {
  const origem = principal.map((m) => m.responseId);
  assert.deepEqual(
    fork.slice(0, 4).map((m) => m.responseId),
    origem,
  );
  assert.equal(new Set(fork.map((m) => m.responseId)).size, 6);
});

test("fixture real: origem e fork somados com o mesmo estado contam cada resposta uma vez", () => {
  const first = addNewUsage(newUsage(), principal, []);
  const second = addNewUsage(first.total, fork, first.counted);
  assert.equal(second.total.input, 120);
  assert.equal(second.total.output, 42);
  assert.equal(second.total.cacheRead, 600);
  assert.equal(second.total.totalTokens, 762);
});

test("fixture real: somar os arquivos sem deduplicar superestima o uso", () => {
  const naive = [...principal, ...fork].reduce((t, m) => t + (m.usage.totalTokens ?? 0), 0);
  assert.equal(naive, 1270);
});

test("fixture real: taxa de acerto do cache com denominador input + cacheRead + cacheWrite", () => {
  const u = addNewUsage(newUsage(), [...principal, ...fork], []).total;
  assert.equal(cacheHitRatio(u), 600 / 720);
});

test("fixture real: custo vem do catálogo do Pi, não do provedor, e não é marcado como reportado", () => {
  const u = addNewUsage(newUsage(), [...principal, ...fork], []).total;
  assert.equal(u.costFromProvider, false);
  assert.ok(u.cost > 0);
});
