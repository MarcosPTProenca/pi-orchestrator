import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorker, type Handler, type Tool } from "./worker-harness.ts";

const endTurn = async (handlers: Record<string, Handler>) => {
  await handlers.agent_end({ messages: [] }, ctx);
  await handlers.agent_settled({}, ctx);
};

const ctx = { sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined } };

async function withTask(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ask-task-"));
  const env = { ...process.env };
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = "t-ask";
    process.env.PI_ORCH_TASK_DIR = dir;
    delete process.env.PI_ORCH_TOOL_POLICY;
    await fn(dir);
  } finally {
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  }
}

const ask = (tools: Record<string, Tool>, params: Record<string, unknown>) =>
  tools.orch_ask.execute("call", { question: "Reutilizar qual contrato?", context: "lib X", ...params });

test("orch_ask operacional grava a pergunta sem finalizar a tarefa", async () => {
  await withTask(async (dir) => {
    const { tools } = loadWorker();
    const r = await ask(tools, { kind: "operacional" });
    const text = r.content[0].text;
    assert.match(text, /encerre o turno/i, "manda encerrar o turno, sem report");
    const file = JSON.parse(readFileSync(join(dir, "ask.json"), "utf8")) as {
      asks: { kind: string; question: string }[];
    };
    assert.equal(file.asks.length, 1);
    assert.equal(file.asks[0].kind, "operacional");
    assert.equal(file.asks[0].question, "Reutilizar qual contrato?");
    assert.equal(existsSync(join(dir, "report.json")), false, "pergunta não grava relatório");
  });
});

test("orch_ask recusa pergunta de produto, arquitetura ou escopo", async () => {
  await withTask(async (dir) => {
    const { tools } = loadWorker();
    for (const kind of ["produto", "arquitetura", "escopo"]) {
      const r = await ask(tools, { kind });
      assert.match(r.content[0].text, /orch_report com status blocked/, `${kind} vai para decisão humana`);
    }
    assert.equal(existsSync(join(dir, "ask.json")), false, "nenhuma pergunta recusada é gravada");
  });
});

test("orch_ask recusa tipo desconhecido", async () => {
  await withTask(async (dir) => {
    const { tools } = loadWorker();
    const r = await ask(tools, { kind: "inventado" });
    assert.match(r.content[0].text, /tipo de pergunta inválido/);
    assert.equal(existsSync(join(dir, "ask.json")), false);
  });
});

test("orch_ask limita perguntas operacionais por tarefa", async () => {
  await withTask(async (dir) => {
    const { tools } = loadWorker();
    for (let i = 0; i < 3; i++) await ask(tools, { kind: "operacional", question: `p${i}` });
    const r = await ask(tools, { kind: "operacional", question: "p4" });
    assert.match(r.content[0].text, /limite de 3/);
    const file = JSON.parse(readFileSync(join(dir, "ask.json"), "utf8")) as { asks: unknown[] };
    assert.equal(file.asks.length, 3);
  });
});

test("turno que fez pergunta não recebe lembrete nem relatório fallback ao encerrar", async () => {
  await withTask(async (dir) => {
    const { handlers, tools } = loadWorker();
    await ask(tools, { kind: "operacional" });
    await endTurn(handlers);
    assert.equal(existsSync(join(dir, "report.json")), false, "pergunta pendente não fecha a tarefa");
  });
});

test("turno sem pergunta continua registrando relatório fallback ao encerrar", async () => {
  await withTask(async (dir) => {
    const { handlers } = loadWorker();
    await endTurn(handlers);
    assert.equal(existsSync(join(dir, "report.json")), true, "fluxo sem pergunta segue como antes");
  });
});

test("a pergunta pendente volta a ser tratada no turno seguinte (resposta recebida)", async () => {
  await withTask(async (dir) => {
    const { handlers, tools } = loadWorker();
    await ask(tools, { kind: "operacional" });
    await handlers.agent_end({ messages: [] }, ctx);
    await handlers.agent_start({}, ctx);
    await endTurn(handlers);
    assert.equal(
      existsSync(join(dir, "report.json")),
      true,
      "após a resposta, o turno seguinte fecha como qualquer turno",
    );
  });
});
