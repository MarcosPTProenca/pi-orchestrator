import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "../src/worker-ext.ts";

/** Sessão simulada: o histórico do ramo ativo é o que o pi persiste (entradas de mensagem customizada). */
function session() {
  const entries: { type: string; customType?: string; content?: string; details?: unknown }[] = [];
  return {
    entries,
    ctx: { sessionManager: { getBranch: () => entries, getEntries: () => entries } },
    /** Aplica o retorno do hook como o pi faz: a mensagem vira entrada da sessão. */
    persist(result: { message?: { customType: string; content: string; details?: unknown } } | undefined) {
      if (result?.message) entries.push({ type: "custom_message", customType: result.message.customType, content: result.message.content, details: result.message.details });
    },
  };
}

function worker() {
  const handlers: Record<string, Function> = {};
  workerExtension({ on: (name: string, fn: Function) => { handlers[name] = fn; }, registerTool: () => {} } as never);
  return handlers;
}

function env(dir: string) {
  process.env.PI_ORCH_ROLE = "worker";
  process.env.PI_ORCH_TASK_ID = "t-brief";
  process.env.PI_ORCH_TASK_DIR = dir;
}

test("brief entregue uma vez: turnos seguintes e orch_send não acrescentam cópias (#100)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-brief-"));
  const previous = { ...process.env };
  try {
    env(dir);
    writeFileSync(join(dir, "brief.md"), "## Pedido do usuário\nCorrija a revisão");
    const s = session();
    const h = worker();
    for (const _turn of [1, 2, 3]) s.persist(h.before_agent_start({ systemPrompt: "base", messageType: "user", prompt: "continue" }, s.ctx));
    const copies = s.entries.filter((e) => e.customType === "orch-brief").length;
    assert.equal(copies, 1, `esperado 1 brief no contexto, encontrado ${copies}`);
  } finally {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reload/reinício: novo carregamento da extensão com o mesmo histórico não injeta outro brief (#100)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-brief-"));
  const previous = { ...process.env };
  try {
    env(dir);
    writeFileSync(join(dir, "brief.md"), "## Pedido do usuário\nCorrija a revisão");
    const s = session();
    s.persist(worker().before_agent_start({ systemPrompt: "base" }, s.ctx));
    const again = worker().before_agent_start({ systemPrompt: "base" }, s.ctx);
    assert.equal(again?.message, undefined, "o histórico já tem o brief: nada a acrescentar");
  } finally {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brief alterado é uma nova versão: entra uma vez, de forma incremental (#100)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-brief-"));
  const previous = { ...process.env };
  try {
    env(dir);
    writeFileSync(join(dir, "brief.md"), "versão 1");
    const s = session();
    const h = worker();
    s.persist(h.before_agent_start({ systemPrompt: "base" }, s.ctx));
    writeFileSync(join(dir, "brief.md"), "versão 2");
    const v2 = h.before_agent_start({ systemPrompt: "base" }, s.ctx);
    assert.match(v2?.message?.content ?? "", /versão 2/);
  } finally {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brief ausente é erro explícito: o worker não inicia sem o contexto obrigatório (#100)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-brief-"));
  const previous = { ...process.env };
  try {
    env(dir);
    const s = session();
    assert.throws(() => worker().before_agent_start({ systemPrompt: "base" }, s.ctx), /brief\.md ausente/);
  } finally {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
