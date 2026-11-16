import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatEvent, FIRST_MATE_ROLE } from "../src/index.ts";

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
});

test("launcher exclui as ferramentas que o orquestrador não pode usar", () => {
  const bin = readFileSync(join(process.cwd(), "bin", "pi-orch"), "utf8");
  for (const tool of ["bash", "edit", "write", "read", "grep", "find", "ls", "subagent", "subagents_enable", "bg_wait", "subagent_supervisor"]) {
    assert.match(bin, new RegExp(`--exclude-tools [^\\n]*\\b${tool}\\b`), `falta excluir ${tool}`);
  }
});
