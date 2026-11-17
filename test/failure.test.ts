import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, suggestModel } from "../src/failure.ts";

test("cota esgotada é classificada como quota", () => {
  assert.equal(classifyFailure("Cota esgotada no provedor do modelo; a tarefa não foi executada. Erro: 429 rate limit"), "quota");
  assert.equal(classifyFailure("usage limit reached for this plan"), "quota");
});

test("HTTP 500 não é cota: é transitória (não sugere trocar de modelo)", () => {
  assert.equal(classifyFailure("Kiro API error: 500 Internal Server Error"), "transient");
  assert.equal(classifyFailure("timed out waiting for response"), "transient");
});

test("credencial inválida é auth; o resto é other", () => {
  assert.equal(classifyFailure("401 Unauthorized: invalid api key"), "auth");
  assert.equal(classifyFailure("o worker ficou ocioso sem chamar orch_report"), "other");
  assert.equal(classifyFailure(""), "other");
});

test("sugere o próximo modelo da prioridade, sem repetir o que falhou", () => {
  const prio = ["claude-bridge/claude-haiku-5-5", "openai-codex/gpt-6-luna", "kiro/auto"];
  assert.equal(suggestModel("claude-bridge/claude-haiku-5-5", prio), "openai-codex/gpt-6-luna");
  assert.equal(suggestModel("kiro/auto", ["kiro/auto"]), null);
});
