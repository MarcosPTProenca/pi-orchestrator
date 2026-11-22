import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFERRABLE_TOOLS, deferredToolsNote, toolExposureFor } from "../src/tool-exposure.ts";
import orchestratorExtension from "../src/index.ts";

const DESTRUCTIVE_OR_ACTING = [
  "orch_delegate",
  "orch_fix_red_prs",
  "orch_send",
  "orch_relaunch",
  "orch_answer",
  "orch_plan_create",
  "orch_plan_update",
  "orch_close",
  "orch_release",
  "orch_cancel",
];

function registeredTools(): Map<string, { exposure?: string; execute: unknown }> {
  const tools = new Map<string, { exposure?: string; execute: unknown }>();
  const pi = new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === "registerTool"
          ? (t: { name: string; exposure?: string; execute: unknown }) => tools.set(t.name, t)
          : () => undefined,
    },
  );
  orchestratorExtension(pi as Parameters<typeof orchestratorExtension>[0]);
  return tools;
}

test("sem o flag, todas as tools orch_* ficam diretas", () => {
  for (const name of [...DEFERRABLE_TOOLS, ...DESTRUCTIVE_OR_ACTING]) {
    assert.equal(toolExposureFor(name, {}), "direct", name);
  }
});

test("hybrid difere só as consultas somente-leitura; ações continuam diretas", () => {
  const env = { PI_ORCH_TOOL_EXPOSURE: "hybrid" };
  assert.deepEqual([...DEFERRABLE_TOOLS].sort(), ["orch_idle", "orch_locate_project", "orch_logs", "orch_plan_show"]);
  for (const name of DEFERRABLE_TOOLS) assert.equal(toolExposureFor(name, env), "deferred", name);
  for (const name of DESTRUCTIVE_OR_ACTING) assert.equal(toolExposureFor(name, env), "direct", name);
  assert.equal(toolExposureFor("orch_delegate", env), "direct");
});

test("nota do papel só aparece no modo híbrido e nomeia as ferramentas diferidas", () => {
  assert.equal(deferredToolsNote({}), "");
  const note = deferredToolsNote({ PI_ORCH_TOOL_EXPOSURE: "hybrid" });
  for (const name of DEFERRABLE_TOOLS) assert.match(note, new RegExp(name));
  assert.match(note, /via codemode/);
});

test("valor desconhecido de PI_ORCH_TOOL_EXPOSURE não ativa o modo híbrido", () => {
  assert.equal(toolExposureFor("orch_logs", { PI_ORCH_TOOL_EXPOSURE: "codemode" }), "direct");
});

test("registro real da extensão aplica exposição e mantém o mesmo execute", () => {
  const before = process.env.PI_ORCH_TOOL_EXPOSURE;
  try {
    delete process.env.PI_ORCH_TOOL_EXPOSURE;
    const direct = registeredTools();
    process.env.PI_ORCH_TOOL_EXPOSURE = "hybrid";
    const hybrid = registeredTools();
    for (const name of DEFERRABLE_TOOLS) {
      assert.equal(direct.get(name)?.exposure, "direct", name);
      assert.equal(hybrid.get(name)?.exposure, "deferred", name);
    }
    for (const name of DESTRUCTIVE_OR_ACTING) {
      assert.ok(hybrid.has(name), name);
      assert.equal(hybrid.get(name)?.exposure ?? "direct", "direct", name);
      assert.equal(String(hybrid.get(name)?.execute), String(direct.get(name)?.execute), `${name}: mesmo código`);
    }
  } finally {
    if (before === undefined) delete process.env.PI_ORCH_TOOL_EXPOSURE;
    else process.env.PI_ORCH_TOOL_EXPOSURE = before;
  }
});

test("launcher só acrescenta --tools +codemode no modo híbrido", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-stub-"));
  const stub = join(dir, "pi");
  writeFileSync(stub, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
  chmodSync(stub, 0o755);
  const launcher = join(import.meta.dirname, "..", "bin", "pi-orch");
  const run = (extra: Record<string, string>) =>
    spawnSync("bash", [launcher, "--foo"], {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH}`, HERDR_ENV: "1", HERDR_PANE_ID: "p1", PI_ORCH_NO_SYNC: "1", ...extra },
    })
      .stdout.trim()
      .split("\n");

  const padrao = run({});
  assert.ok(!padrao.includes("--tools"), padrao.join(" "));
  assert.equal(padrao.at(-1), "--foo");

  const hibrido = run({ PI_ORCH_TOOL_EXPOSURE: "hybrid" });
  assert.deepEqual(hibrido.slice(hibrido.indexOf("--tools"), hibrido.indexOf("--tools") + 2), ["--tools", "+codemode"]);
  assert.equal(hibrido.at(-1), "--foo");
});
