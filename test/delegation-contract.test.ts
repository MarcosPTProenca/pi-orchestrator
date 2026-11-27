import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildIntake, renderBrief } from "../src/shared/intake.ts";
import { ORCHESTRATOR_ROLE } from "../src/orchestrator/extension.ts";

function project(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "delegation-contract-")), "proj");
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

test("brief não tem seção de pedido literal; o trabalho vem formulado pelo orquestrador", () => {
  const pack = buildIntake({
    project_path: project(),
    role: "a",
    request: "Corrigir o parser de datas.",
    objective: "y",
    mode: "report",
  });
  const brief = renderBrief("t-x", pack, "/r.json");
  assert.match(brief, /^## O que fazer\nCorrigir o parser de datas\./m);
  assert.doesNotMatch(brief, /literal/);
});

test("o prompt do orquestrador não manda copiar o pedido completo para a retomada", () => {
  assert.doesNotMatch(ORCHESTRATOR_ROLE, /preserve o pedido completo/);
  assert.match(ORCHESTRATOR_ROLE, /instrução concreta/);
});

test("direct-pr autorizado gera brief coerente: commit, push e PR nos critérios, sem proibição de publicação (#244)", () => {
  const pack = buildIntake({
    project_path: project(),
    role: "impl-224",
    request: "Implementar a issue #224.",
    objective: "Issue #224 concluída com PR.",
    mode: "direct-pr",
    constraints: ["Não tocar em outros arquivos."],
    source: "https://github.com/exemplo/herdr/issues/224",
    branch: "feat/issue-224",
  });
  const brief = renderBrief("t-x", pack, "/r.json");
  assert.match(brief, /Commit na branch `feat\/issue-224`, push e PR aberto ou atualizado com gh\./);
  assert.match(brief, /^## Restrições\n1\. Não tocar em outros arquivos\./m);
  assert.doesNotMatch(brief, /Não faça commit/i);
  assert.doesNotMatch(brief, /Nenhum push e nenhum PR/);
});

test("pesquisa que proíbe publicação mantém a restrição e o critério de não publicar (#244)", () => {
  const pack = buildIntake({
    project_path: project(),
    role: "pesquisa",
    request: "Investigar a issue #224.",
    objective: "Relatório.",
    mode: "report",
    constraints: ["Não faça commit, push ou abra PR."],
  });
  const brief = renderBrief("t-y", pack, "/r.json");
  assert.match(brief, /^## Restrições\n1\. Não faça commit, push ou abra PR\./m);
  assert.match(brief, /Nenhum push e nenhum PR\./);
  assert.doesNotMatch(brief, /Commit na branch/);
});
