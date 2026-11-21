import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, writeReport } from "./fakes.ts";

const HAIKU = "claude-bridge/claude-haiku-5-5";
const LUNA = "openai-codex/gpt-6.1-sol";

async function failed(h: ReturnType<typeof makeHarness>, result: string, model?: string) {
  const t = await h.orch.delegate({
    project_path: h.project,
    role: "a",
    request: "x",
    objective: "y",
    mode: "report",
    model,
  });
  writeReport(t.task_dir, t.task_id, { status: "failed", result });
  await h.orch.refresh(t.task_id);
  return t;
}

test("falha por cota: relança com outro modelo explícito; a nova tarefa aponta para a anterior", async () => {
  const h = makeHarness();
  const old = await failed(h, "Cota esgotada no provedor do modelo. Erro: 429 rate limit", HAIKU);
  const neu = await h.orch.relaunch(old.task_id, LUNA);
  assert.equal(neu.model, LUNA);
  assert.equal(h.orch.get(neu.task_id).relaunched_from, old.task_id);
  assert.match(readFileSync(neu.brief_path, "utf8"), new RegExp(`Tentativa anterior \\(${old.task_id}\\)`));
  assert.equal(h.orch.get(old.task_id).status, "failed", "a anterior não muda");
});

test("falha por cota sem modelo informado: recusa e diz o que fazer", async () => {
  const h = makeHarness();
  const old = await failed(h, "Cota esgotada. Erro: 429", HAIKU);
  await assert.rejects(h.orch.relaunch(old.task_id), /informe o modelo/);
});

test("falha por cota com o mesmo modelo que esgotou: recusa", async () => {
  const h = makeHarness();
  const old = await failed(h, "Cota esgotada. Erro: 429", HAIKU);
  await assert.rejects(h.orch.relaunch(old.task_id, HAIKU), /esgotou a cota; escolha outro/);
});

test("falha de credencial: recusa modelo do mesmo provedor e aceita outro provedor", async () => {
  const h = makeHarness();
  const old = await failed(h, "401 Unauthorized: invalid api key", HAIKU);
  await assert.rejects(
    h.orch.relaunch(old.task_id, "claude-bridge/claude-sonnet-5"),
    /escolha modelo de outro provedor/,
  );
  const neu = await h.orch.relaunch(old.task_id, LUNA);
  assert.equal(neu.model, LUNA);
});

test("falha transitória (HTTP 500): relança com o mesmo modelo, sem exigir troca", async () => {
  const h = makeHarness();
  const old = await failed(h, "Encerrou com erro do modelo. Erro: Kiro API error: 500 Internal Server Error", HAIKU);
  const neu = await h.orch.relaunch(old.task_id);
  assert.equal(neu.model, HAIKU);
});

test("tarefa ainda ativa não relança; tarefa não falha não relança", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" });
  await assert.rejects(h.orch.relaunch(t.task_id, LUNA), /ainda está ativa/);
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("sem sessão: o brief traz o fim do relatório e o caminho do arquivo completo", async () => {
  const h = makeHarness();
  const longResult = `${"x".repeat(800)} FIM-DO-RELATORIO`;
  const old = await failed(h, longResult, HAIKU);
  const neu = await h.orch.relaunch(old.task_id);
  const brief = readFileSync(neu.brief_path, "utf8");
  assert.match(brief, /FIM-DO-RELATORIO/);
  assert.ok(brief.includes(join(old.task_dir, "report.json")));
});

test("relançamento encadeado: o brief da 2ª tentativa não copia o relatório da 1ª", async () => {
  const h = makeHarness();
  const first = await failed(h, `PRIMEIRO-RELATORIO ${"z".repeat(3000)}`, HAIKU);
  const second = await h.orch.relaunch(first.task_id);
  writeReport(second.task_dir, second.task_id, { status: "failed", result: "SEGUNDO-RELATORIO Erro: 500" });
  await h.orch.refresh(second.task_id);
  const third = await h.orch.relaunch(second.task_id);
  const brief = readFileSync(third.brief_path, "utf8");
  assert.match(brief, /SEGUNDO-RELATORIO/);
  assert.doesNotMatch(brief, /PRIMEIRO-RELATORIO/, "aviso da tentativa anterior não pode se acumular");
  assert.equal((brief.match(/Tentativa anterior \(/g) ?? []).length, 1);
});

test("com a sessão da tentativa anterior em disco: o relançamento faz fork dela (--fork), sem alterar a original", async () => {
  const h = makeHarness();
  const old = await failed(h, "Encerrou com erro do modelo. Erro: 500", HAIKU);
  const dir = mkdtempSync(join(tmpdir(), "orch-sess-"));
  const session = join(dir, "prev.jsonl");
  try {
    writeFileSync(session, "{}\n");
    writeFileSync(join(old.task_dir, "session.txt"), session);
    const neu = await h.orch.relaunch(old.task_id);
    const cmd = (h.herdr.opsOf("runInPane").at(-1)!.args as { command: string }).command;
    assert.match(cmd, new RegExp(`--fork '?${session.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}'?`));
    assert.match(readFileSync(neu.brief_path, "utf8"), /copiada para esta sessão/);
    assert.equal(readFileSync(session, "utf8"), "{}\n", "a sessão original não muda");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sem sessão gravada (ou arquivo sumido): relança em sessão nova, sem --fork", async () => {
  const h = makeHarness();
  const old = await failed(h, "Encerrou com erro do modelo. Erro: 500", HAIKU);
  writeFileSync(join(old.task_dir, "session.txt"), "/nao/existe/sessao.jsonl");
  await h.orch.relaunch(old.task_id);
  const cmd = (h.herdr.opsOf("runInPane").at(-1)!.args as { command: string }).command;
  assert.doesNotMatch(cmd, /--fork/);
});
