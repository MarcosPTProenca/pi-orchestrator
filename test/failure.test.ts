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

test("erro do provedor: orientação diz que a causa não está comprovada e como relançar (#64)", async () => {
  const { failureHintFor } = await import("../src/failure.ts");
  const hint = failureHintFor('500: {"message":"An error occurred while processing your request. Please try again."}', "t-x1");
  assert.match(hint, /transitório do provedor/);
  assert.match(hint, /causa não está comprovada/);
  assert.match(hint, /orch_relaunch\(task_id="t-x1"\)/);
});

test("erro desconhecido: diz que a causa é desconhecida e manda ver o log, sem prometer relançamento", async () => {
  const { failureHintFor } = await import("../src/failure.ts");
  const hint = failureHintFor("o worker ficou ocioso sem chamar orch_report", "t-x2");
  assert.match(hint, /Causa desconhecida/);
  assert.match(hint, /orch_logs\(task_id="t-x2"\)/);
  assert.doesNotMatch(hint, /orch_relaunch/);
});

test("credencial: avisa que relançar sem corrigir falha de novo", async () => {
  const { failureHintFor } = await import("../src/failure.ts");
  assert.match(failureHintFor("401 Unauthorized: invalid api key", "t-x3"), /não troque de modelo/);
});
