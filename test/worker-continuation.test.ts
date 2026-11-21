import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension, { REPORT_REMINDER } from "../src/worker-ext.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;
const FAKE_CTX = { sessionManager: { getEntries: () => [] } };

async function withWorker(
  taskId: string,
  fn: (h: Record<string, Handler>, dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "orch-cont-"));
  const prev = {
    role: process.env.PI_ORCH_ROLE,
    id: process.env.PI_ORCH_TASK_ID,
    dir: process.env.PI_ORCH_TASK_DIR,
    url: process.env.PI_ORCH_HOOK_URL,
  };
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = taskId;
    process.env.PI_ORCH_TASK_DIR = dir;
    delete process.env.PI_ORCH_HOOK_URL;
    const handlers: Record<string, Handler> = {};
    workerExtension({
      on: (name: string, f: Handler) => {
        handlers[name] = (event, ctx) => f(event, ctx ?? FAKE_CTX);
      },
      registerTool: () => {},
    } as never);
    await fn(handlers, dir);
  } finally {
    for (const [k, v] of [
      ["PI_ORCH_ROLE", prev.role],
      ["PI_ORCH_TASK_ID", prev.id],
      ["PI_ORCH_TASK_DIR", prev.dir],
      ["PI_ORCH_HOOK_URL", prev.url],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const silentEnd = { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] };
const errorEnd = {
  messages: [{ role: "assistant", content: [], errorMessage: "500: An error occurred while processing your request." }],
};
const settleEvent = { entries: [], continue: false, context: {}, outcome: {} };

test("fim de turno sem relatório e sem erro: uma continuação com lembrete, depois falha com motivo (#57)", () =>
  withWorker("t-c1", async (h, dir) => {
    await h.agent_end(silentEnd);
    assert.equal(existsSync(join(dir, "report.json")), false, "não grava falha antes da continuação");
    const r = (await h.agent_before_settle(settleEvent)) as {
      continue: boolean;
      entries: { customType?: string; content?: string }[];
    };
    assert.equal(r.continue, true);
    assert.ok(r.entries.some((e) => e.customType === "orch-report-reminder" && e.content === REPORT_REMINDER));
    await h.agent_end(silentEnd);
    const rep = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.equal(rep.status, "failed");
    assert.equal(rep.source, "fallback");
    assert.match(rep.result, /Encerrou o turno sem chamar orch_report/);
  }));

test("lembrete é único: a segunda passagem por before_settle não pede outra continuação", () =>
  withWorker("t-c2", async (h) => {
    await h.agent_end(silentEnd);
    assert.ok(await h.agent_before_settle(settleEvent));
    await h.agent_end(silentEnd);
    assert.equal(await h.agent_before_settle(settleEvent), undefined);
  }));

test("erro do modelo não ganha continuação: falha na hora, com o erro", () =>
  withWorker("t-c3", async (h, dir) => {
    await h.agent_end(errorEnd);
    const rep = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.equal(rep.status, "failed");
    assert.match(rep.result, /erro do modelo/);
    assert.equal(await h.agent_before_settle(settleEvent), undefined);
  }));

test("relatório válido que chega durante a continuação não é sobrescrito pela falha (#57)", () =>
  withWorker("t-c4", async (h, dir) => {
    await h.agent_end(silentEnd);
    assert.ok(await h.agent_before_settle(settleEvent));
    writeFileSync(
      join(dir, "report.json"),
      JSON.stringify({
        task_id: "t-c4",
        status: "done",
        result: "entregue na continuação",
        question: null,
        artifacts: [],
        reported_at: "2",
      }),
    );
    await h.agent_end(silentEnd);
    const rep = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.equal(rep.status, "done");
    assert.equal(rep.result, "entregue na continuação");
  }));

test("execução termina sem segundo agent_end (abort, sem contexto): agent_settled grava a falha adiada (#57)", () =>
  withWorker("t-c5", async (h, dir) => {
    await h.agent_end(silentEnd);
    assert.equal(existsSync(join(dir, "report.json")), false);
    await h.agent_settled({ aborted: true });
    const rep = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.equal(rep.status, "failed");
    assert.equal(rep.source, "fallback");
  }));

test("agent_settled sem fallback adiado não grava nada", () =>
  withWorker("t-c6", async (h, dir) => {
    await h.agent_settled({ aborted: false });
    assert.equal(existsSync(join(dir, "report.json")), false);
  }));

test("agent_settled depois da continuação concluída não regrava nem sobrescreve", () =>
  withWorker("t-c7", async (h, dir) => {
    await h.agent_end(silentEnd);
    await h.agent_before_settle(settleEvent);
    writeFileSync(
      join(dir, "report.json"),
      JSON.stringify({
        task_id: "t-c7",
        status: "done",
        result: "ok",
        question: null,
        artifacts: [],
        reported_at: "2",
      }),
    );
    await h.agent_end(silentEnd);
    await h.agent_settled({ aborted: false });
    assert.equal(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).status, "done");
  }));
