import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import workerExtension from "../src/worker-ext.ts";

type Result = { systemPrompt?: string; message?: unknown } | undefined;
type Handler = (event: { systemPrompt: string }, ctx?: unknown) => Result;
type Appended = { customType: string; data: { sha256: string; content: string } };

function loadWorker(appended: Appended[] = []): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  workerExtension({
    on: (name: string, fn: Handler) => {
      handlers[name] = fn;
    },
    registerTool: () => {},
    registerEntryRenderer: () => {},
    appendEntry: (customType: string, data: Appended["data"]) => appended.push({ customType, data }),
  } as never);
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

test("o brief não entra no prompt de sistema nem como mensagem: o worker o lê por ferramenta (#102)", () =>
  withTask("## Pedido do usuário\nCorrija a revisão", () => {
    const result = loadWorker().before_agent_start({ systemPrompt: "base" });
    assert.equal(result?.message, undefined);
    assert.doesNotMatch(result?.systemPrompt ?? "", /Corrija a revisão/);
  }));

test("exibição do brief: uma entrada custom por sha, fora do contexto do modelo (#100)", () =>
  withTask("## Pedido do usuário\nCorrija a revisão", () => {
    const appended: Appended[] = [];
    const h = loadWorker(appended);
    h.before_agent_start({ systemPrompt: "base" }, { sessionManager: { getBranch: () => [] } });
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.customType, "orch-brief");
    const history = appended.map((a) => ({ type: "custom", customType: a.customType, data: a.data }));
    h.before_agent_start({ systemPrompt: "base" }, { sessionManager: { getBranch: () => history } });
    assert.equal(appended.length, 1, "reload/turno seguinte não repete a exibição");
  }));

test("preâmbulo do worker não se repete entre turnos", () =>
  withTask("pedido", () => {
    const h = loadWorker();
    const once = h.before_agent_start({ systemPrompt: "base" })?.systemPrompt ?? "";
    const twice = h.before_agent_start({ systemPrompt: once })?.systemPrompt ?? "";
    assert.equal(twice, once);
    assert.equal(once.split("worker lançado pelo orquestrador").length - 1, 1);
  }));

test("brief alterado gera nova exibição com a versão nova (#100)", () =>
  withTask("versão 1", (dir) => {
    const appended: Appended[] = [];
    const h = loadWorker(appended);
    h.before_agent_start({ systemPrompt: "base" });
    writeFileSync(join(dir, "brief.md"), "versão 2");
    h.before_agent_start({ systemPrompt: "base" });
    assert.equal(appended.length, 2);
    assert.match(appended[1]?.data.content ?? "", /versão 2/);
    assert.notEqual(appended[0]?.data.sha256, appended[1]?.data.sha256);
  }));

test("segredo no brief é mascarado na exibição", () =>
  withTask("usar token=abcdef123456 para o teste", () => {
    const appended: Appended[] = [];
    loadWorker(appended).before_agent_start({ systemPrompt: "base" });
    assert.doesNotMatch(appended[0]?.data.content ?? "", /abcdef123456/);
    assert.match(appended[0]?.data.content ?? "", /\[mascarado\]/);
  }));

test("brief ausente é erro explícito: o worker não inicia sem o contexto obrigatório (#100)", () =>
  withTask(null, () => {
    assert.throws(() => loadWorker().before_agent_start({ systemPrompt: "base" }), /brief\.md ausente/);
  }));

test("regressão #102: entradas de exibição não quebram a identidade do contexto do worker", () =>
  withTask("## Pedido do usuário\nCorrija a revisão", () => {
    const sm = SessionManager.inMemory("/tmp");
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "oi" }], timestamp: Date.now() });
    const appended: Appended[] = [];
    const r = loadWorker(appended).before_agent_start({ systemPrompt: "base" });
    const m = r?.message as { customType: string; content: string; display: boolean; details?: unknown } | undefined;
    if (m) sm.appendCustomMessageEntry(m.customType, m.content, m.display, m.details);
    for (const a of appended) sm.appendCustomEntry(a.customType, a.data);
    const captured = sm.buildSessionProjection().messages;
    sm.appendMessage(assistantStub());
    const after = sm.buildSessionProjection().messages;
    assert.equal(
      captured.every((msg, i) => after[i] === msg),
      true,
    );
    assert.equal(
      sm.getEntries().some((e) => e.type === "custom_message"),
      false,
    );
  }));

test("regressão #102 (controle): brief como custom_message quebra a identidade", () => {
  const sm = SessionManager.inMemory("/tmp");
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "oi" }], timestamp: Date.now() });
  sm.appendCustomMessageEntry("orch-brief", "pedido", true, { sha256: "x" });
  const captured = sm.buildSessionProjection().messages;
  sm.appendMessage(assistantStub());
  const after = sm.buildSessionProjection().messages;
  assert.equal(
    captured.every((msg, i) => after[i] === msg),
    false,
  );
});

function assistantStub(): never {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never;
}

test("multi-turno: o brief não volta ao contexto do modelo em turnos seguintes nem em continuação (#100)", () =>
  withTask("## Pedido do usuário\nCorrija a revisão", () => {
    const sm = SessionManager.inMemory("/tmp");
    const appended: Appended[] = [];
    const h = loadWorker(appended);
    const briefInContext = () => JSON.stringify(sm.buildSessionProjection().messages).includes("Corrija a revisão");
    const runTurn = (prompt: string) => {
      sm.appendMessage({ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() });
      const history = sm.getEntries().map((e) => ({ type: e.type, ...(e as object) }));
      const r = h.before_agent_start({ systemPrompt: "base" }, { sessionManager: { getBranch: () => history } });
      const m = r?.message as { customType: string; content: string; display: boolean } | undefined;
      if (m) sm.appendCustomMessageEntry(m.customType, m.content, m.display, undefined);
      for (const a of appended.splice(0)) sm.appendCustomEntry(a.customType, a.data);
      sm.appendMessage(assistantStub());
    };
    runTurn("primeira tarefa");
    runTurn("orch_send: ajuste o teste");
    runTurn("orch_answer: pode seguir");
    assert.equal(briefInContext(), false);
    assert.equal(
      sm.getEntries().filter((e) => e.type === "custom_message").length,
      0,
      "nenhuma cópia do brief entra como mensagem",
    );
  }));
