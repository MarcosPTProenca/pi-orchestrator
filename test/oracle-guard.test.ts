import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_ONLY_TOOLS } from "../src/shared/review.ts";
import { appendAsk } from "../src/shared/ask.ts";
import { OracleCaptures, consultToken, oracleToolGate } from "../src/orchestrator/oracle-guard.ts";
import { settleOracleVerdict } from "../src/orchestrator/oracle-ask.ts";

const answered = (answer = "use o helper de src/shared/x.ts") =>
  JSON.stringify({ verdict: "answered", answer, reason: "spec cita o helper", uncertainty: "" });

const entry = (id: string) => ({
  id,
  kind: "operacional",
  question: "Reutilizar qual contrato?",
  context: "encontrei dois helpers",
  asked_at: "2026-11-26T12:00:00Z",
});

function freshTask(askId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oracle-guard-"));
  appendAsk(dir, entry(askId));
  return dir;
}

test("consultToken é determinístico por tarefa e pergunta, e tem 16 hex", () => {
  const a = consultToken("t-1", "a1");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(consultToken("t-1", "a1"), a);
  assert.notEqual(consultToken("t-1", "a2"), a, "outra pergunta, outro marcador");
  assert.notEqual(consultToken("t-2", "a1"), a, "outra tarefa, outro marcador");
});

test("oracleToolGate recusa qualquer ferramenta que escreve ou executa", () => {
  for (const bad of ["bash", "edit", "write"]) {
    const reason = oracleToolGate([...READ_ONLY_TOOLS, bad]);
    assert.ok(reason, `a ferramenta ${bad} precisa ser recusada`);
    assert.ok(reason.includes(bad));
  }
  assert.ok(oracleToolGate(undefined), "sem lista declarada não há prova de somente leitura");
  assert.ok(oracleToolGate([]), "lista vazia não passa");
});

test("oracleToolGate aceita somente ferramentas de leitura, inclusive subconjunto", () => {
  assert.equal(oracleToolGate([...READ_ONLY_TOOLS]), null);
  assert.equal(oracleToolGate(["read", "grep"]), null);
});

test("OracleCaptures captura a saída do subagent oracle lançado com o marcador da consulta", () => {
  const cap = new OracleCaptures();
  const token = consultToken("t-1", "a1");
  cap.noteCall("call-1", { agent: "oracle", task: `pergunta...\nMarcador de consulta: ${token}.`, model: "m" });
  cap.noteResult("call-1", answered(), false);
  const got = cap.get(token);
  assert.ok(got);
  assert.equal(got.output, answered());
  assert.equal(got.agent, "oracle");
  assert.equal(got.toolCallId, "call-1");
});

test("OracleCaptures ignora chamadas sem marcador, de outro agente, com erro ou sem chamada prévia", () => {
  const cap = new OracleCaptures();
  const token = consultToken("t-1", "a1");
  cap.noteCall("c1", { agent: "researcher", task: `Marcador de consulta: ${token}` });
  cap.noteResult("c1", answered(), false);
  cap.noteCall("c2", { agent: "oracle", task: "sem marcador" });
  cap.noteResult("c2", answered(), false);
  cap.noteCall("c3", { agent: "oracle", task: `Marcador de consulta: ${token}` });
  cap.noteResult("c3", "erro do subagent", true);
  cap.noteResult("c4", answered(), false);
  assert.equal(cap.get(token), undefined);
});

test("settleOracleVerdict sem captura da consulta recusa o parecer e não grava nada", () => {
  const dir = freshTask("a1");
  assert.throws(
    () => settleOracleVerdict({ taskId: "t-1", taskDir: dir, askId: "a1", raw: answered(), capture: undefined }),
    /sem consulta registrada/,
  );
  assert.equal(existsSync(join(dir, "oracle.json")), false, "forjado não consome a consulta");
});

test("settleOracleVerdict recusa parecer que não aparece na saída real do subagent", () => {
  const dir = freshTask("a1");
  const token = consultToken("t-1", "a1");
  const capture = { token, agent: "oracle", model: null, toolCallId: "c1", output: "saída real: inconclusive" };
  assert.throws(
    () => settleOracleVerdict({ taskId: "t-1", taskDir: dir, askId: "a1", raw: answered(), capture }),
    /não confere com a saída do subagent/,
  );
  assert.equal(existsSync(join(dir, "oracle.json")), false, "a consulta real segue disponível");
});

test("settleOracleVerdict com saída real grava o parecer e a origem (agente, tool call, hash)", () => {
  const dir = freshTask("a1");
  const token = consultToken("t-1", "a1");
  const raw = answered();
  const capture = { token, agent: "oracle", model: "m-x", toolCallId: "c9", output: `texto\n${raw}\n` };
  const text = settleOracleVerdict({ taskId: "t-1", taskDir: dir, askId: "a1", raw, capture });
  assert.match(text, /Parecer answered registrado/);
  const saved = JSON.parse(readFileSync(join(dir, "oracle.json"), "utf8")) as {
    verdicts: Record<string, string>;
    origins: Record<string, { agent: string; model: string | null; tool_call_id: string; output_sha256: string }>;
  };
  assert.equal(saved.verdicts.a1, "answered");
  assert.equal(saved.origins.a1.agent, "oracle");
  assert.equal(saved.origins.a1.model, "m-x");
  assert.equal(saved.origins.a1.tool_call_id, "c9");
  assert.match(saved.origins.a1.output_sha256, /^[0-9a-f]{64}$/);
});
