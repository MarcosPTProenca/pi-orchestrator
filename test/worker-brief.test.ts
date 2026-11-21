import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "../src/worker-ext.ts";

type Entry = { type: string; customType?: string; content?: string; details?: unknown };

function sessionWith(entries: Entry[]) {
  return { ctx: { sessionManager: { getBranch: () => entries, getEntries: () => entries } } };
}

function persist(entries: Entry[], result: { message?: Entry } | undefined) {
  if (result?.message) entries.push({ type: "custom_message", customType: result.message.customType, content: result.message.content, details: result.message.details });
}

function loadWorker(): Record<string, Function> {
  const handlers: Record<string, Function> = {};
  workerExtension({ on: (name: string, fn: Function) => { handlers[name] = fn; }, registerTool: () => {} } as never);
  return handlers;
}

function withTask(brief: string | null, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "orch-brief-"));
  const previous = { ...process.env };
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = "t-brief";
    process.env.PI_ORCH_TASK_DIR = dir;
    if (brief !== null) writeFileSync(join(dir, "brief.md"), brief);
    fn(dir);
  } finally {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("brief entregue uma vez: turnos seguintes e orch_send não acrescentam cópias (#100)", () =>
  withTask("## Pedido do usuário\nCorrija a revisão", () => {
    const entries: Entry[] = [];
    const s = sessionWith(entries);
    const h = loadWorker();
    for (let turn = 0; turn < 3; turn++) persist(entries, h.before_agent_start({ systemPrompt: "base", messageType: "user", prompt: "continue" }, s.ctx));
    assert.equal(entries.filter((e) => e.customType === "orch-brief").length, 1);
  }));

test("reload: outro carregamento da extensão com o mesmo histórico não injeta outro brief (#100)", () =>
  withTask("## Pedido do usuário\nCorrija a revisão", () => {
    const entries: Entry[] = [];
    const s = sessionWith(entries);
    persist(entries, loadWorker().before_agent_start({ systemPrompt: "base" }, s.ctx));
    assert.equal(loadWorker().before_agent_start({ systemPrompt: "base" }, s.ctx)?.message, undefined);
  }));

test("brief alterado é nova versão e entra de forma incremental (#100)", () =>
  withTask("versão 1", (dir) => {
    const entries: Entry[] = [];
    const s = sessionWith(entries);
    const h = loadWorker();
    persist(entries, h.before_agent_start({ systemPrompt: "base" }, s.ctx));
    writeFileSync(join(dir, "brief.md"), "versão 2");
    assert.match(h.before_agent_start({ systemPrompt: "base" }, s.ctx)?.message?.content ?? "", /versão 2/);
  }));

test("brief ausente é erro explícito: o worker não inicia sem o contexto obrigatório (#100)", () =>
  withTask(null, () => {
    assert.throws(() => loadWorker().before_agent_start({ systemPrompt: "base" }, sessionWith([]).ctx), /brief\.md ausente/);
  }));
