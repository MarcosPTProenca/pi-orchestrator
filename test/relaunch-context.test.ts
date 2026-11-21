import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDOFF_EXCERPT_CHARS, RELAUNCH_MARK, relaunchContext, relaunchNotice } from "../src/relaunch-context.ts";

const base = {
  taskId: "t-1",
  kind: "transient" as const,
  reportPath: "/tmp/t-1/report.json",
  branch: "feat/x",
  artifacts: ["https://github.com/o/r/pull/9"],
};

test("contexto: com sessão anterior gravada faz fork; sem ela, handoff novo", () => {
  assert.equal(relaunchContext("/sessoes/prev.jsonl"), "fork-with-history");
  assert.equal(relaunchContext(null), "fresh-with-handoff");
});

test("fork: o aviso aponta o relatório em arquivo e não copia o texto dele", () => {
  const notice = relaunchNotice({ ...base, context: "fork-with-history", report: "y".repeat(50_000) });
  assert.match(notice, /copiada para esta sessão/);
  assert.ok(notice.includes(base.reportPath));
  assert.ok(notice.length < 1000, `aviso de fork cresceu com o relatório: ${notice.length} caracteres`);
  assert.doesNotMatch(notice, /yyyyy/);
});

test("fresh: traz classe, branch, artefatos, caminho e só o fim do relatório", () => {
  const report = `${"a".repeat(10_000)} ERRO-FINAL`;
  const notice = relaunchNotice({ ...base, context: "fresh-with-handoff", report });
  assert.match(notice, /Classe da falha: transient/);
  assert.match(notice, /Branch: feat\/x/);
  assert.match(notice, /pull\/9/);
  assert.ok(notice.includes(base.reportPath));
  assert.match(notice, /ERRO-FINAL/);
  assert.doesNotMatch(notice, /a{3000}/, "trecho deve ser limitado");
  assert.ok(notice.length < HANDOFF_EXCERPT_CHARS + 800, `aviso fresh grande demais: ${notice.length}`);
});

test("fresh sem branch, artefatos ou relatório: diz explicitamente o que falta", () => {
  const notice = relaunchNotice({
    ...base,
    context: "fresh-with-handoff",
    report: "",
    branch: null,
    artifacts: [],
  });
  assert.match(notice, /Branch: não informada/);
  assert.match(notice, /Artefatos: nenhum/);
  assert.match(notice, /sem detalhe/);
});

test("todo aviso começa com a marca que o relançamento usa para descartar avisos antigos", () => {
  for (const context of ["fork-with-history", "fresh-with-handoff"] as const) {
    const notice = relaunchNotice({ ...base, context, report: "x" });
    assert.ok(notice.startsWith(`${RELAUNCH_MARK}${base.taskId}) falhou.`), notice);
  }
});
