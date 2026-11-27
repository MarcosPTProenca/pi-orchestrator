import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { invalidToolRelease, toolCallBlockReason, workerToolArgs, workerToolSet } from "../src/shared/worker-tools.ts";
import workerExtension from "../src/worker/worker-ext.ts";
import { makeHarness } from "./fakes.ts";

type ToolHandler = (event: { toolName: string; input: unknown }) => unknown;

const toolsOf = (args: string[]): string[] => args[args.indexOf("--tools") + 1].split(",");

test("padrão restritivo: report sem MCP, só ferramentas do modo e contratos orch_*", () => {
  const args = workerToolArgs("report", []);
  assert.deepEqual(args.slice(0, 1), ["--no-mcp"]);
  const tools = toolsOf(args);
  assert.ok(tools.includes("read") && tools.includes("orch_report"));
  assert.ok(!tools.includes("edit") && !tools.includes("write"), "report não edita");
  assert.ok(!tools.some((t) => t.startsWith("mcp__")), "nenhum servidor MCP por padrão");
  assert.ok(!tools.includes("codemode") && !tools.includes("subagent"), "codemode e subagent ficam fora");
});

test("direct-pr mantém edit e write e continua sem MCP por padrão", () => {
  const args = workerToolArgs("direct-pr", []);
  assert.equal(args[0], "--no-mcp");
  const tools = toolsOf(args);
  for (const t of ["bash", "edit", "write", "orch_report"]) assert.ok(tools.includes(t), t);
});

test("liberação explícita remove --no-mcp e inclui só o que foi pedido", () => {
  const args = workerToolArgs("report", ["mcp__plane__*"]);
  assert.ok(!args.includes("--no-mcp"));
  assert.ok(toolsOf(args).includes("mcp__plane__*"));
});

test("toolCallBlockReason bloqueia ferramenta de tracker fora da política, com motivo claro", () => {
  const policy = { mode: "report" as const, allowed: workerToolSet("report", []) };
  const reason = toolCallBlockReason("mcp__plane__workitem", policy);
  assert.ok(reason);
  assert.match(reason, /mcp__plane__workitem não liberada para o modo report/);
  assert.match(reason, /allowed_tools/);
  assert.equal(toolCallBlockReason("read", policy), null);
});

test("toolCallBlockReason libera mcp__plane__* quando a tarefa liberou", () => {
  const policy = { mode: "report" as const, allowed: workerToolSet("report", ["mcp__plane__*"]) };
  assert.equal(toolCallBlockReason("mcp__plane__workitem", policy), null);
  assert.ok(toolCallBlockReason("mcp__github__issue", policy), "outro servidor continua bloqueado");
});

test("allowed_tools aceita só nome de ferramenta MCP", () => {
  assert.equal(invalidToolRelease(["mcp__plane__*", "mcp__plane__workitem"]), null);
  assert.match(invalidToolRelease(["bash"]) ?? "", /allowed_tools inválido: bash/);
  assert.match(invalidToolRelease(["mcp__plane"]) ?? "", /inválido/);
});

test("delegate report: lança com --no-mcp e política de ferramentas no ambiente do worker", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({
    project_path: h.project,
    role: "investigate",
    request: "Analise",
    objective: "Analise",
    mode: "report",
  });
  const cmd = (h.herdr.opsOf("runInPane")[0].args as { command: string }).command;
  assert.match(cmd, /^pi -e \/fake\/worker-ext\.ts -e \/fake\/pr-review\/hook\.ts --no-mcp --tools /);
  assert.ok(!cmd.includes("mcp__"));
  assert.deepEqual(t.released_tools, []);
  const env = (h.herdr.opsOf("createTab")[0].args as { env: Record<string, string> }).env;
  const policy = JSON.parse(env.PI_ORCH_TOOL_POLICY) as { mode: string; allowed: string[] };
  assert.equal(policy.mode, "report");
  assert.ok(!policy.allowed.some((p) => p.startsWith("mcp__")));
});

test("delegate report com allowed_tools mcp__plane__*: liberação aparece no lançamento e no registro da tarefa", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({
    project_path: h.project,
    role: "investigate",
    request: "Leia o ticket",
    objective: "Leia o ticket",
    mode: "report",
    allowed_tools: ["mcp__plane__*"],
  });
  const cmd = (h.herdr.opsOf("runInPane")[0].args as { command: string }).command;
  assert.ok(!cmd.includes("--no-mcp"), "com liberação os servidores conectam");
  assert.match(cmd, /mcp__plane__\*/);
  assert.deepEqual(t.released_tools, ["mcp__plane__*"]);
  assert.equal(h.orch.get(t.task_id).released_tools?.[0], "mcp__plane__*");
});

test("allowed_tools inválido recusa a delegação antes de lançar", async () => {
  const h = makeHarness();
  await assert.rejects(
    h.orch.delegate({
      project_path: h.project,
      role: "investigate",
      request: "x",
      objective: "x",
      mode: "report",
      allowed_tools: ["bash"],
    }),
    /allowed_tools inválido/,
  );
  assert.equal(h.herdr.opsOf("runInPane").length, 0);
});

test("regressão direct-pr: continua lançando com ferramentas de publicação e sem MCP", async () => {
  const h = makeHarness();
  const t = await h.orch.delegate({
    project_path: h.project,
    role: "fix",
    request: "Corrija",
    objective: "Testes passam",
    mode: "direct-pr",
    branch: "feat/x",
  });
  assert.equal(t.status, "running");
  const cmd = (h.herdr.opsOf("runInPane")[0].args as { command: string }).command;
  assert.match(
    cmd,
    /^pi -e \/fake\/worker-ext\.ts -e \/fake\/pr-review\/hook\.ts --no-mcp --tools 'read,bash,edit,write,/,
  );
  assert.equal(readFileSync(t.brief_path, "utf8").includes("modo: direct-pr"), true);
});

function withToolPolicy(policy: unknown, fn: (handlers: Record<string, ToolHandler>) => void): void {
  const prev = { role: process.env.PI_ORCH_ROLE, pol: process.env.PI_ORCH_TOOL_POLICY };
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TOOL_POLICY = JSON.stringify(policy);
    const handlers: Record<string, ToolHandler> = {};
    workerExtension({
      on: (name: string, f: ToolHandler) => {
        handlers[name] = f;
      },
      registerTool: () => {},
      registerEntryRenderer: () => {},
      appendEntry: () => {},
    } as never);
    fn(handlers);
  } finally {
    for (const [k, v] of [
      ["PI_ORCH_ROLE", prev.role],
      ["PI_ORCH_TOOL_POLICY", prev.pol],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("handler do worker report bloqueia ferramenta de tracker com a mensagem de política", () => {
  withToolPolicy({ mode: "report", allowed: workerToolSet("report", []) }, (h) => {
    const r = h.tool_call({ toolName: "mcp__plane__workitem", input: {} }) as { block: boolean; reason: string };
    assert.equal(r.block, true);
    assert.match(r.reason, /mcp__plane__workitem não liberada para o modo report/);
    assert.equal(h.tool_call({ toolName: "read", input: { path: "x" } }), undefined);
  });
});

test("handler do worker com mcp__plane__* liberado deixa a chamada passar", () => {
  withToolPolicy({ mode: "report", allowed: workerToolSet("report", ["mcp__plane__*"]) }, (h) => {
    assert.equal(h.tool_call({ toolName: "mcp__plane__workitem", input: {} }), undefined);
  });
});

test("handler do worker com política ilegível bloqueia (fail-closed)", () => {
  const prev = process.env.PI_ORCH_TOOL_POLICY;
  try {
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TOOL_POLICY = "{not json";
    const handlers: Record<string, ToolHandler> = {};
    workerExtension({
      on: (n: string, f: ToolHandler) => (handlers[n] = f),
      registerTool: () => {},
      registerEntryRenderer: () => {},
      appendEntry: () => {},
    } as never);
    const r = handlers.tool_call({ toolName: "read", input: {} }) as { block: boolean };
    assert.equal(r.block, true);
  } finally {
    delete process.env.PI_ORCH_ROLE;
    if (prev === undefined) delete process.env.PI_ORCH_TOOL_POLICY;
    else process.env.PI_ORCH_TOOL_POLICY = prev;
  }
});
