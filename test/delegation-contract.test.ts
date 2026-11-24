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
