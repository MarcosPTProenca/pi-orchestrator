import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatEvent, modelMessageFor, FIRST_MATE_ROLE } from "../src/index.ts";

const base = { task_id: "t-abcdef123456", project_id: "rko", result: null, question: null, artifacts: [], error: null };

test("mensagem de conclusão traz resultado, sem campos técnicos", () => {
  const msg = formatEvent({ ...base, status: "done", result: "3 falhas", artifacts: ["/r.md"] } as never);
  assert.equal(msg, "[123456] rko: concluído. 3 falhas\nArquivos: /r.md");
});

test("bloqueio apresenta a decisão ao usuário", () => {
  const msg = formatEvent({ ...base, status: "blocked", question: "A ou B?" } as never);
  assert.match(msg, /precisa de uma decisão: A ou B\?/);
});

test("prazo vencido pergunta o que fazer, não diz que vai cancelar sozinho", () => {
  const msg = formatEvent({ ...base, status: "timeout" } as never);
  assert.match(msg, /Quer que eu cancele\?/);
});

test("papel do orquestrador: não executa trabalho de projeto e lança pelas tools", () => {
  assert.match(FIRST_MATE_ROLE, /Não executa o trabalho do projeto/);
  assert.match(FIRST_MATE_ROLE, /orch_delegate/);
  assert.match(FIRST_MATE_ROLE, /orch_fix_red_prs/);
  assert.match(FIRST_MATE_ROLE, /orch_locate_project antes de perguntar/);
});

test("launcher exclui só os subagents ocultos; o orquestrador mantém as ferramentas normais do Pi", () => {
  const bin = readFileSync(join(process.cwd(), "bin", "pi-orch"), "utf8");
  const line = bin.split("\n").find((l) => l.includes("--exclude-tools")) ?? "";
  assert.match(line, /--exclude-tools subagent,subagents_enable/);
  for (const tool of ["bash", "read", "edit", "write", "grep", "find", "ls"]) {
    assert.doesNotMatch(line, new RegExp(`\\b${tool}\\b`), `${tool} não deve ser excluído`);
  }
});

test("mensagem ao orquestrador pede resumo curto e não cola o relatório", () => {
  const long = "x".repeat(5000);
  const msg = modelMessageFor({ ...base, status: "done", result: long, artifacts: ["https://github.com/o/r/pull/1"] } as never);
  assert.match(msg, /\[evento de worker\]/);
  assert.match(msg, /Responda ao usuário em até 5 linhas/);
  assert.match(msg, /truncado/);
  assert.ok(msg.length < 2000, "bruto não cabe inteiro");
  assert.match(msg, /https:\/\/github\.com\/o\/r\/pull\/1/);
});
