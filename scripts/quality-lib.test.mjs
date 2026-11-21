import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compare,
  countCommentLines,
  deadCodeCount,
  lintErrorCount,
  typeErrorCount,
  unformattedCount,
} from "./quality-lib.mjs";

test("conta linhas de comentário e ignora shortcut:", () => {
  const src = "const a = 1; // um\n/* dois\n tres */\nconst s = 'https://x.y'; // shortcut: limite, quando subir\n";
  assert.equal(countCommentLines(src).lines, 1 + 2);
});

test("não conta barra dentro de string como comentário", () => {
  assert.equal(countCommentLines("const u = 'http://a/b';\n").lines, 0);
});

test("soma itens de todas as categorias do knip, sem contar o arquivo", () => {
  const report = {
    issues: [
      { file: "a.ts", exports: [{}, {}], types: [{}], files: [], unlisted: [] },
      { file: "b.ts", binaries: [{}] },
    ],
  };
  assert.equal(deadCodeCount(report), 4);
  assert.equal(deadCodeCount({}), 0);
});

test("conta erros do tsc, não linhas de contexto", () => {
  assert.equal(typeErrorCount("src/a.ts(1,1): error TS2304: nome\nsrc/b.ts(2,2): error TS1005: x\nnada aqui\n"), 2);
  assert.equal(typeErrorCount(""), 0);
});

test("regressão é métrica acima do baseline; melhoria é abaixo; meta é separada", () => {
  const targets = { duplication_pct: 0, dead_code: 0, comment_lines: 0, type_errors: 0 };
  const baseline = { duplication_pct: 1, dead_code: 5, comment_lines: 100, type_errors: 0 };
  const current = { duplication_pct: 1.5, dead_code: 3, comment_lines: 100, type_errors: 0 };
  const r = compare(current, baseline, targets);
  assert.deepEqual(
    r.regressions.map((x) => x.metric),
    ["duplication_pct"],
  );
  assert.deepEqual(
    r.improvements.map((x) => x.metric),
    ["dead_code"],
  );
  assert.equal(r.rows.find((x) => x.metric === "type_errors").meta, true);
  assert.equal(r.rows.find((x) => x.metric === "dead_code").meta, false, "3 > meta 0");
});

test("sem baseline não há regressão, só o estado atual contra a meta", () => {
  const r = compare(
    { duplication_pct: 2, dead_code: 0, comment_lines: 0, type_errors: 0 },
    {},
    { duplication_pct: 0, dead_code: 0, comment_lines: 0, type_errors: 0 },
  );
  assert.equal(r.regressions.length, 0);
  assert.equal(r.rows[0].meta, false);
});

test("comentário depois de regex com barras não é lido como fim de linha", () => {
  const src = "const r = /\\/\\/[^@]*@/; // depois\n";
  assert.equal(countCommentLines(src, "a.ts").lines, 1);
});

test("conta erros de lint somando as mensagens de todos os arquivos", () => {
  assert.equal(lintErrorCount([{ messages: [{}, {}] }, { messages: [] }, { messages: [{}] }]), 3);
});

test("conta arquivos fora do formato, ignorando linhas em branco", () => {
  assert.equal(unformattedCount("src/a.ts\nsrc/b.ts\n\n"), 2);
  assert.equal(unformattedCount(""), 0);
});
