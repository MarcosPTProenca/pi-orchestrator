import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { buildIntake, readVision, renderBrief } from "../src/shared/intake.ts";
import { missingVisionNotice, resetVisionNotices } from "../src/orchestrator/scope.ts";

function project(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "vision-")), "proj");
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

const base = { role: "a", request: "pedido", objective: "objetivo", mode: "report" as const };

test("Pi carrega AGENTS.md e CLAUDE.md nativamente no projeto", () => {
  const dir = project();
  writeFileSync(join(dir, "AGENTS.md"), "INSTRUÇÃO-AGENTS-NATIVA");
  writeFileSync(join(dir, "CLAUDE.md"), "INSTRUÇÃO-CLAUDE-NATIVA");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
  const loaded = loadProjectContextFiles({ cwd: dir, agentDir });
  assert.deepEqual(
    loaded.map((file) => file.content),
    ["INSTRUÇÃO-AGENTS-NATIVA"],
  );
  const claudeOnly = project();
  writeFileSync(join(claudeOnly, "CLAUDE.md"), "INSTRUÇÃO-CLAUDE-NATIVA");
  assert.deepEqual(
    loadProjectContextFiles({ cwd: claudeOnly, agentDir }).map((file) => file.content),
    ["INSTRUÇÃO-CLAUDE-NATIVA"],
  );
});

test("brief não duplica instruções nativas do Pi, mas mantém VISION.md", () => {
  const dir = project();
  writeFileSync(join(dir, "AGENTS.md"), "INSTRUÇÃO-AGENTS-NATIVA");
  writeFileSync(join(dir, "CLAUDE.md"), "INSTRUÇÃO-CLAUDE-NATIVA");
  writeFileSync(join(dir, "VISION.md"), "VISÃO-DO-PROJETO");
  const pack = buildIntake({ ...base, project_path: dir });
  const brief = renderBrief("t-instructions", pack, "/tmp/report.json");
  assert.doesNotMatch(brief, /INSTRUÇÃO-(?:AGENTS|CLAUDE)-NATIVA/);
  assert.ok(brief.includes("VISÃO-DO-PROJETO"));
});

test("VISION.md ausente: intake marca missing e o brief diz que não há visão", () => {
  const dir = project();
  const pack = buildIntake({ ...base, project_path: dir });
  assert.deepEqual(pack.vision, { status: "missing" });
  const brief = renderBrief("t-00000001", pack, "/tmp/report.json");
  assert.match(brief, /## Visão do projeto \(VISION\.md\)/);
  assert.match(brief, /não tem VISION\.md na raiz/);
});

test("VISION.md presente: o conteúdo entra inteiro no brief, sem corte", () => {
  const dir = project();
  const long = `# Visão\n\n${"linha de visão com detalhe concreto\n".repeat(400)}\nFIM-DA-VISAO`;
  assert.ok(long.length > 6000, "precisa passar do limite de instruções para provar que não corta");
  writeFileSync(join(dir, "VISION.md"), long);
  const pack = buildIntake({ ...base, project_path: dir });
  assert.deepEqual(pack.vision, { status: "present", content: long });
  const brief = renderBrief("t-00000002", pack, "/tmp/report.json");
  assert.ok(brief.includes(long), "o brief precisa conter a visão inteira");
  assert.ok(brief.includes("FIM-DA-VISAO"));
  assert.doesNotMatch(brief, /\[truncado\]/);
});

test("VISION.md ilegível (caminho é diretório): intake marca unreadable com o motivo e o brief avisa", () => {
  const dir = project();
  mkdirSync(join(dir, "VISION.md"));
  const vision = readVision(dir);
  assert.equal(vision.status, "unreadable");
  if (vision.status !== "unreadable") return;
  assert.ok(vision.reason.length > 0);
  const pack = buildIntake({ ...base, project_path: dir });
  assert.equal(pack.vision.status, "unreadable");
  const brief = renderBrief("t-00000003", pack, "/tmp/report.json");
  assert.match(brief, /existe mas não pôde ser lido/);
});

test("aviso de VISION ausente sai uma vez por projeto, depois fica quieto", () => {
  resetVisionNotices();
  const dir = project();
  const missing = { status: "missing" as const };
  const first = missingVisionNotice(dir, missing);
  assert.ok(first && first.includes("VISION.md") && first.includes("skill `vision`"));
  assert.equal(missingVisionNotice(dir, missing), null);
  assert.ok(missingVisionNotice(project(), missing), "outro projeto tem o seu aviso");
});

test("VISION presente ou ilegível não gera aviso", () => {
  resetVisionNotices();
  const dir = project();
  assert.equal(missingVisionNotice(dir, { status: "present", content: "x" }), null);
  assert.equal(missingVisionNotice(dir, { status: "unreadable", reason: "EACCES" }), null);
});
