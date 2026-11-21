import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, failureHintFor, suggestModel } from "../src/failure.ts";

test("cota esgotada é classificada como quota", () => {
  assert.equal(
    classifyFailure("Cota esgotada no provedor do modelo; a tarefa não foi executada. Erro: 429 rate limit"),
    "quota",
  );
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

test("erro do provedor: orientação diz que a causa não está comprovada e como relançar (#64)", () => {
  const hint = failureHintFor(
    '500: {"message":"An error occurred while processing your request. Please try again."}',
    "t-x1",
  );
  assert.match(hint, /transitório do provedor/);
  assert.match(hint, /causa não está comprovada/);
  assert.match(hint, /orch_relaunch\(task_id="t-x1"\)/);
});

test("erro desconhecido: diz que a causa é desconhecida e manda ver o log, sem prometer relançamento", () => {
  const hint = failureHintFor("o worker ficou ocioso sem chamar orch_report", "t-x2");
  assert.match(hint, /Causa desconhecida/);
  assert.match(hint, /orch_logs\(task_id="t-x2"\)/);
  assert.doesNotMatch(hint, /orch_relaunch/);
});

test("credencial: orientação diz que a troca de provedor é automática", () => {
  assert.match(failureHintFor("401 Unauthorized: invalid api key", "t-x3"), /troca de provedor sozinho/);
});

test("credencial falha troca para outro provedor, nunca o mesmo (autonomia do orquestrador)", async () => {
  const { nextModelFor } = await import("../src/failure.ts");
  const prio = ["claude-bridge/claude-haiku-5-5", "claude-bridge/claude-sonnet-5", "openai-codex/gpt-6-luna"];
  assert.equal(nextModelFor("claude-bridge/claude-haiku-5-5", "auth", prio), "openai-codex/gpt-6-luna");
  assert.equal(nextModelFor("openai-codex/gpt-6-luna", "auth", prio), "claude-bridge/claude-haiku-5-5");
  assert.equal(nextModelFor("claude-bridge/claude-haiku-5-5", "auth", ["claude-bridge/claude-haiku-5-5"]), null);
});

test("cota troca para qualquer outro modelo da prioridade", async () => {
  const { nextModelFor } = await import("../src/failure.ts");
  const prio = ["claude-bridge/claude-haiku-5-5", "claude-bridge/claude-sonnet-5"];
  assert.equal(nextModelFor("claude-bridge/claude-haiku-5-5", "quota", prio), "claude-bridge/claude-sonnet-5");
});

test("cadeia de relançamentos conta os saltos e tem limite contra ciclo", async () => {
  const { chainDepth } = await import("../src/failure.ts");
  const tasks: Record<string, { relaunched_from?: string | null }> = {
    "t-a": {},
    "t-b": { relaunched_from: "t-a" },
    "t-c": { relaunched_from: "t-b" },
    "t-loop": { relaunched_from: "t-loop" },
  };
  const get = (id: string) => tasks[id];
  assert.equal(chainDepth(tasks["t-a"], get), 0);
  assert.equal(chainDepth(tasks["t-c"], get), 2);
  assert.equal(chainDepth(tasks["t-loop"], get), 10);
});
