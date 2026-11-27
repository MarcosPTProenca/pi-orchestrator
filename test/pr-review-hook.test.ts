import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prReviewHook, { createReviewHook, prRefFromUrl, prUrlsFromCreate, reviewModels } from "../src/pr-review/hook.ts";
import { readReview, reviewFile } from "../src/shared/review-verdict.ts";

const REPO = "MarcosPTProenca/pi-orchestrator";
const URL = `https://github.com/${REPO}/pull/300`;
const BASE = "b".repeat(40);
const H1 = "a".repeat(40);
const H2 = "c".repeat(40);
const PR = { owner: "MarcosPTProenca", name: "pi-orchestrator", number: 300 };

const verdictJson = (reviewed: string, verdict = "approve") =>
  JSON.stringify({
    schema_version: 2,
    verdict,
    reviewed_sha: reviewed,
    risk_assessment: { level: "L1", category: "local", reason: "ajuste", evidence: ["src/x.ts:1"], confidence: "high" },
    requires_human_judgment: false,
    scope_drift: false,
    criteria: [{ id: "AC-1", status: "pass", evidence: "src/x.ts:1" }],
    findings: [],
    suggestions: [],
  });

const CREATE = "gh pr create --title t --body b";
const PUSH = "git push origin feat/x";

// Fake do gh e do revisor: nenhum processo real, nenhuma rede.
function setup(opts: { runner: (prompt: string) => string | Promise<string>; state?: string }) {
  const state = { head: H1, state: opts.state ?? "OPEN" };
  const runs: string[] = [];
  const stateDir = mkdtempSync(join(tmpdir(), "prhook-"));
  const hook = createReviewHook({
    stateDir,
    gh: async (args) => {
      if (args[0] === "pr" && args[1] === "diff") return "diff --git a/src/x.ts b/src/x.ts\n+ok\n";
      if (args.includes("url")) return JSON.stringify({ url: URL });
      return JSON.stringify({ state: state.state, headRefOid: state.head, baseRefOid: BASE, title: "t", body: "b" });
    },
    runner: async (input) => {
      runs.push(input.prompt);
      return opts.runner(input.prompt);
    },
  });
  const fire = (command: string, output = `${URL}\n`) =>
    hook.onToolResult(
      { toolName: "bash", input: { command }, content: [{ type: "text", text: output }], isError: false },
      {
        cwd: "/tmp",
      },
    );
  return { hook, stateDir, state, runs, fire };
}

test("prUrlsFromCreate: só a saída de gh pr create conta como PR criada", () => {
  assert.deepEqual(prUrlsFromCreate(CREATE, `${URL}\n`), [URL]);
  assert.deepEqual(prUrlsFromCreate("gh pr list", `${URL}\n`), [], "listar PR não dispara review");
});

test("prRefFromUrl extrai dono, repo e número; URL que não é PR do GitHub é recusada", () => {
  assert.deepEqual(prRefFromUrl(URL), PR);
  assert.throws(() => prRefFromUrl("https://example.com/x"), /não reconhecida/);
});

test("modelos do revisor: padrão da Factory, ajustável por PI_ORCH_REVIEW_MODELS", () => {
  assert.ok(reviewModels({}).length >= 1);
  assert.deepEqual(reviewModels({ PI_ORCH_REVIEW_MODELS: "a/x, b/y" }), ["a/x", "b/y"]);
});

test("hook só registra no worker; a sessão do revisor (PI_ORCH_ROLE=reviewer) não dispara review", () => {
  const seen: string[] = [];
  const fakePi = { on: (name: string) => seen.push(name) } as never;
  const prev = process.env.PI_ORCH_ROLE;
  try {
    process.env.PI_ORCH_ROLE = "reviewer";
    prReviewHook(fakePi);
    assert.deepEqual(seen, []);
    process.env.PI_ORCH_ROLE = "worker";
    prReviewHook(fakePi);
    assert.deepEqual(seen, ["tool_result"]);
  } finally {
    if (prev === undefined) delete process.env.PI_ORCH_ROLE;
    else process.env.PI_ORCH_ROLE = prev;
  }
});

test("criação de PR grava veredito approve no store, vinculado ao head exato", async () => {
  const s = setup({ runner: () => verdictJson(H1) });
  await s.fire(CREATE);
  assert.equal(readReview(s.stateDir, PR, H1)?.verdict, "approve");
  assert.ok(reviewFile(s.stateDir, PR, H1).endsWith(`pr300/${H1}.json`));
});

test("veredito com SHA divergente é rejeitado: nunca vira approve", async () => {
  const s = setup({ runner: () => verdictJson(H2) });
  await s.fire(CREATE);
  const r = readReview(s.stateDir, PR, H1);
  assert.equal(r?.verdict, "unverified");
  assert.notEqual(r?.verdict, "approve");
});

test("novo push invalida a aprovação do SHA anterior", async () => {
  const s = setup({ runner: (prompt) => (prompt.includes(H1) ? verdictJson(H1) : "não é json") });
  await s.fire(CREATE);
  assert.equal(readReview(s.stateDir, PR, H1)?.verdict, "approve");
  s.state.head = H2;
  await s.fire(PUSH, "");
  assert.equal(readReview(s.stateDir, PR, H2)?.verdict, "unverified", "o head novo precisa do próprio review");
  assert.notEqual(readReview(s.stateDir, PR, H2)?.verdict, "approve", "approve de H1 não vale para H2");
});

test("o mesmo url@sha não dispara dois reviews", async () => {
  const s = setup({ runner: () => verdictJson(H1) });
  await s.fire(CREATE);
  await s.fire(CREATE);
  assert.equal(s.runs.length, 1);
});

test("PR fechada não é revisada", async () => {
  const s = setup({ runner: () => verdictJson(H1), state: "CLOSED" });
  await s.fire(CREATE);
  assert.equal(s.runs.length, 0);
});
