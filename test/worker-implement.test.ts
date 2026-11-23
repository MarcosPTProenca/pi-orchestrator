import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toExecutionTicket } from "../src/shared/execution-ticket.ts";
import { EVIDENCE_FILE, readEvidenceLog } from "../src/shared/execution-evidence.ts";
import { readPublishState, writePublishState } from "../src/shared/publish.ts";
import { TICKET_FILE } from "../src/shared/plan.ts";
import workerExtension from "../src/worker/worker-ext.ts";

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;
type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };

function loadWorker(): { handlers: Record<string, Handler>; tools: Record<string, Tool> } {
  const handlers: Record<string, Handler> = {};
  const tools: Record<string, Tool> = {};
  workerExtension({
    on: (name: string, fn: Handler) => {
      handlers[name] = fn;
    },
    registerTool: (t: { name: string } & Tool) => {
      tools[t.name] = t;
    },
    registerEntryRenderer: () => {},
    appendEntry: () => {},
  } as never);
  return { handlers, tools };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

interface Fixture {
  root: string;
  taskDir: string;
  head: string;
  cleanup: () => void;
}

function fixture(mode: "report" | "direct-pr", state?: object): Fixture {
  const base = mkdtempSync(join(tmpdir(), "impl-"));
  const remote = join(base, "remote.git");
  const root = join(base, "repo");
  const taskDir = join(base, "task");
  mkdirSync(taskDir);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "feat/x");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", "a.ts");
  git(root, "commit", "-qm", "init");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "feat/x");
  const head = git(root, "rev-parse", "HEAD");
  const ticket = toExecutionTicket(
    {
      project_path: root,
      role: "impl",
      request: "Corrigir o bug X",
      objective: "Bug X corrigido",
      mode,
      acceptance: ["Teste de regressão passa", "npm test verde"],
    },
    {
      task_id: "t-impl",
      attempt_id: "a-1",
      report_path: join(taskDir, "report.json"),
      base_sha: "b0",
      validation: { schema_version: 1, commands: ["npm test"], exceptions: [] },
    },
  );
  writeFileSync(join(taskDir, TICKET_FILE), JSON.stringify(ticket));
  writeFileSync(join(taskDir, "brief.md"), "## Pedido\nCorrigir o bug X");
  if (state) writeFileSync(join(taskDir, "publish-state.json"), JSON.stringify(state));
  const env = { ...process.env };
  const cwd = process.cwd();
  process.env.PI_ORCH_ROLE = "worker";
  process.env.PI_ORCH_TASK_ID = "t-impl";
  process.env.PI_ORCH_TASK_DIR = taskDir;
  process.chdir(root);
  return {
    root,
    taskDir,
    head,
    cleanup: () => {
      process.chdir(cwd);
      process.env = env;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const bashCall = (command: string) => ({ toolName: "bash", input: { command } });
const gate = async (w: ReturnType<typeof loadWorker>, command: string): Promise<string | undefined> => {
  const r = (await w.handlers.tool_call(bashCall(command))) as { block?: boolean; reason?: string } | undefined;
  return r?.block ? r.reason : undefined;
};

test("sem ticket, bash não é bloqueado pelo gate de publicação", async () => {
  const f = fixture("direct-pr");
  try {
    rmSync(join(f.taskDir, TICKET_FILE));
    assert.equal(await gate(loadWorker(), "git push origin feat/x"), undefined);
  } finally {
    f.cleanup();
  }
});

test("report: git push é bloqueado porque allowed_actions é vazio", async () => {
  const f = fixture("report");
  try {
    assert.match(String(await gate(loadWorker(), "git push origin feat/x")), /allowed_actions/);
  } finally {
    f.cleanup();
  }
});

test("direct-pr: commit liberado, mas push de HEAD já publicado é bloqueado", async () => {
  const f = fixture("direct-pr", {
    task_id: "t-impl",
    attempt_id: "a-1",
    branch: "feat/x",
    base_sha: "b0",
    head_sha: null,
    pushed_sha: null,
    pr_url: null,
  });
  try {
    const w = loadWorker();
    assert.equal(await gate(w, "git commit -m x"), undefined);
    writePublishState(f.taskDir, { ...readPublishState(f.taskDir)!, pushed_sha: f.head });
    assert.match(String(await gate(w, "git push origin feat/x")), /já publicado/);
  } finally {
    f.cleanup();
  }
});

test("subagent pr-reviewer é bloqueado: o hook de review já dispara na PR", async () => {
  const f = fixture("direct-pr");
  try {
    const r = (await loadWorker().handlers.tool_call({ toolName: "subagent", input: { agent: "pr-reviewer" } })) as {
      block?: boolean;
      reason?: string;
    };
    assert.equal(r.block, true);
    assert.match(r.reason ?? "", /hook/);
  } finally {
    f.cleanup();
  }
});

test("bash real: exit code vem do resultado da ferramenta e a marca TDD aponta para ele", async () => {
  const f = fixture("direct-pr");
  try {
    const w = loadWorker();
    await w.handlers.tool_result({
      toolName: "bash",
      input: { command: "node --test test/a.test.ts" },
      details: { exit_code: 1 },
      content: [{ type: "text", text: "not ok 1 - a\nexit 1" }],
      isError: true,
    });
    const r = await w.tools.orch_mark_tdd.execute("id", { seam: "S1", phase: "red" });
    assert.match(r.content[0].text, /S1.*red.*exit 1/);
    const log = readEvidenceLog(f.taskDir);
    assert.equal(log.commands[0].exit_code, 1);
    assert.deepEqual(log.marks, [{ seam: "S1", phase: "red", command_index: 0 }]);
  } finally {
    f.cleanup();
  }
});

test("push e PR registram o estado real no publish-state.json e capturam a URL da PR", async () => {
  const f = fixture("direct-pr");
  try {
    const w = loadWorker();
    await w.handlers.tool_result({
      toolName: "bash",
      input: { command: "gh pr create --title t" },
      details: { exit_code: 0 },
      content: [{ type: "text", text: "https://github.com/o/r/pull/77\n" }],
      isError: false,
    });
    const state = readPublishState(f.taskDir);
    assert.equal(state?.branch, "feat/x");
    assert.equal(state?.head_sha, f.head);
    assert.equal(state?.pr_url, "https://github.com/o/r/pull/77");
    assert.equal(
      await gate(w, "gh pr create --title again"),
      "PR já registrada (https://github.com/o/r/pull/77): atualize a existente em vez de criar outra",
    );
  } finally {
    f.cleanup();
  }
});

test("retomada: prompt recebe a branch e a PR já publicadas, e não manda criar outra", async () => {
  const f = fixture("direct-pr", {
    task_id: "t-impl",
    attempt_id: "a-1",
    branch: "feat/x",
    base_sha: "b0",
    head_sha: "h0",
    pushed_sha: null,
    pr_url: "https://github.com/o/r/pull/77",
  });
  try {
    const r = (await loadWorker().handlers.before_agent_start(
      { systemPrompt: "base" },
      { sessionManager: { getBranch: () => [] } },
    )) as { systemPrompt: string };
    assert.match(r.systemPrompt, /branch feat\/x/);
    assert.match(r.systemPrompt, /pull\/77/);
    assert.match(r.systemPrompt, /não crie outra PR/);
    assert.match(r.systemPrompt, /não acione o subagent pr-reviewer/);
  } finally {
    f.cleanup();
  }
});

function writePlan(taskDir: string): void {
  writeFileSync(
    join(taskDir, "implementation-plan.json"),
    JSON.stringify({
      schema_version: 1,
      task_id: "t-impl",
      attempt_id: "a-1",
      kind: "bug",
      test_seams: [{ name: "S1", boundary: "cli" }],
      steps: [{ id: "S1", action: "regressão", files: [], verifies: [], check: "node --test" }],
      deviations: [],
    }),
  );
}

test("agent_end grava execution-evidence.json: incompleto sem skill, completo com skill e TDD válido", async () => {
  const f = fixture("direct-pr");
  try {
    const w = loadWorker();
    writePlan(f.taskDir);
    await w.handlers.tool_result({
      toolName: "bash",
      input: { command: "node --test" },
      details: { exit_code: 1 },
      content: [{ type: "text", text: "fail" }],
      isError: true,
    });
    await w.tools.orch_mark_tdd.execute("id", { seam: "S1", phase: "red" });
    await w.handlers.tool_result({
      toolName: "bash",
      input: { command: "node --test" },
      details: { exit_code: 0 },
      content: [{ type: "text", text: "pass" }],
      isError: false,
    });
    await w.tools.orch_mark_tdd.execute("id", { seam: "S1", phase: "green" });
    await w.tools.orch_report.execute("id", { status: "done", result: "ok" });

    const ctxWith = (entries: unknown[]) => ({
      sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionFile: () => null },
    });
    await w.handlers.agent_end({ messages: [] }, ctxWith([]));
    const without = JSON.parse(readFileSync(join(f.taskDir, EVIDENCE_FILE), "utf8")) as {
      complete: boolean;
      missing: string[];
    };
    assert.equal(without.complete, false);
    assert.match(without.missing.join(";"), /skill implement não carregada/);

    const skillEntry = {
      type: "message",
      message: { role: "user", content: '<skill name="implement" location="/x/SKILL.md">\nbody\n</skill>\n\nLeia' },
    };
    await w.handlers.agent_end({ messages: [] }, ctxWith([skillEntry]));
    const withSkill = JSON.parse(readFileSync(join(f.taskDir, EVIDENCE_FILE), "utf8")) as {
      complete: boolean;
      missing: string[];
      tdd: { seams: unknown[] };
      skill: { loaded: boolean };
    };
    assert.equal(withSkill.skill.loaded, true);
    assert.deepEqual(withSkill.missing, []);
    assert.equal(withSkill.complete, true);
    assert.equal(withSkill.tdd.seams.length, 1);
  } finally {
    f.cleanup();
  }
});
