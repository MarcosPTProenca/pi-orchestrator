import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  IntegrationStore,
  decideIntegration,
  requestIntegration,
  type CheckRunFact,
  type IntegrationInput,
  type MergeGithub,
  type PrSnapshot,
  type Protection,
  type RepoFacts,
  type TrustedReviewer,
} from "../src/shared/merge-gate.ts";
import { defaultMergePolicy, type MergePolicy, type TicketFacts } from "../src/shared/merge-policy.ts";

const REPO = "MarcosPTProenca/pi-orchestrator";
const NUMBER = 200;
const TICKET = "t-146";
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const REVIEWER: TrustedReviewer = { app_slug: "pi-reviewer-app", check_name: "pi-review" };

const policy = (over: Partial<MergePolicy> = {}): MergePolicy => ({
  ...defaultMergePolicy(REPO, TICKET),
  auto_merge: true,
  authorization: { granted_by: "user", ticket_id: TICKET },
  ...over,
});

const ticket = (over: Partial<TicketFacts> = {}): TicketFacts => ({
  id: TICKET,
  state: "done",
  branch: "feat/x",
  allowed_paths: ["src/"],
  ...over,
});

const ciRun = (head = HEAD, over: Partial<CheckRunFact> = {}): CheckRunFact => ({
  name: "test",
  app_slug: "github-actions",
  head_sha: head,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  ...over,
});

const reviewRun = (head = HEAD, over: Partial<CheckRunFact> = {}): CheckRunFact => ({
  name: "pi-review",
  app_slug: "pi-reviewer-app",
  head_sha: head,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  ...over,
});

const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  repo: REPO,
  number: NUMBER,
  state: "OPEN",
  is_draft: false,
  head_ref: "feat/x",
  head_sha: HEAD,
  base_ref: "master",
  mergeable: "MERGEABLE",
  merge_state_status: "CLEAN",
  auto_merge_enabled: false,
  linked_issue: 146,
  changed_files: 1,
  files: [{ path: "src/worker/fixture.ts", kind: "modified", additions: 3, deletions: 1 }],
  check_runs: [ciRun(), reviewRun()],
  ...over,
});

const REPO_OK: RepoFacts = { allow_auto_merge: true, default_branch: "master" };
const PROTECTED_OK: Protection = { status: "protected", required_contexts: ["test"] };

function input(over: Partial<IntegrationInput> = {}): IntegrationInput {
  return {
    policy: policy(),
    ticket: ticket(),
    pr: pr(),
    repo: REPO_OK,
    protection: PROTECTED_OK,
    reviewer: REVIEWER,
    expected_head_sha: HEAD,
    ...over,
  };
}

const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

test("PR verde no mesmo head, revisor confiável aprovou e auto-merge habilitado: pede merge squash com SHA", () => {
  const r = decideIntegration(input());
  assert.equal(r.decision, "merge_requested");
  assert.deepEqual(r.merge_args, [
    "pr",
    "merge",
    String(NUMBER),
    "--repo",
    REPO,
    "--auto",
    "--squash",
    "--match-head-commit",
    HEAD,
  ]);
  assert.equal(r.merge_args?.includes("--admin"), false);
});

test("sem autorização de auto-merge: manual_approval e nenhum pedido de merge", () => {
  const r = decideIntegration(input({ policy: policy({ auto_merge: false }) }));
  assert.equal(r.decision, "manual_approval");
  assert.equal(r.merge_args, null);
  assert.ok(codes(r).includes("no_merge_authorization"));
});

test("risco L2 (dependência) exige humano: manual_approval", () => {
  const r = decideIntegration(
    input({
      ticket: ticket({ allowed_paths: ["src/", "package.json"] }),
      pr: pr({ files: [{ path: "package.json", kind: "modified", additions: 1, deletions: 1 }] }),
    }),
  );
  assert.equal(r.decision, "manual_approval");
  assert.equal(r.merge_args, null);
});

test("risco L3 (workflow de CI) exige humano: manual_approval", () => {
  const r = decideIntegration(
    input({
      ticket: ticket({ allowed_paths: ["src/", ".github/"] }),
      pr: pr({ files: [{ path: ".github/workflows/ci.yml", kind: "modified", additions: 1, deletions: 0 }] }),
    }),
  );
  assert.equal(r.decision, "manual_approval");
});

test("allow_auto_merge=false no repo: setup_required com passos, sem simular ativação", () => {
  const r = decideIntegration(input({ repo: { allow_auto_merge: false, default_branch: "master" } }));
  assert.equal(r.decision, "setup_required");
  assert.equal(r.merge_args, null);
  assert.ok(r.setup_steps.some((s) => s.includes("allow_auto_merge")));
  assert.ok(r.setup_steps.every((s) => !/--admin/.test(s)));
});

test("branch sem proteção: setup_required pedindo branch protection com check 'test'", () => {
  const r = decideIntegration(input({ protection: { status: "unprotected" } }));
  assert.equal(r.decision, "setup_required");
  assert.ok(r.setup_steps.some((s) => s.includes("branch protection") && s.includes("test")));
});

test("proteção sem o check obrigatório 'test': setup_required", () => {
  const r = decideIntegration(input({ protection: { status: "protected", required_contexts: ["lint"] } }));
  assert.equal(r.decision, "setup_required");
});

test("erro ao consultar proteção: blocked (fail closed)", () => {
  const r = decideIntegration(input({ protection: { status: "unknown", error: "HTTP 500" } }));
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("protection_unknown"));
});

test("sem revisor confiável configurado: manual_approval (review não verificável)", () => {
  const r = decideIntegration(input({ reviewer: null }));
  assert.equal(r.decision, "manual_approval");
  assert.ok(codes(r).includes("review_unverified"));
});

test("review publicado por app não confiável (worker forjando) não conta", () => {
  const r = decideIntegration(input({ pr: pr({ check_runs: [ciRun(), reviewRun(HEAD, { app_slug: null })] }) }));
  assert.equal(r.decision, "manual_approval");
  assert.ok(codes(r).includes("review_unverified"));
});

test("aprovação de SHA anterior não vale para o head atual (aprovação obsoleta)", () => {
  const r = decideIntegration(input({ pr: pr({ check_runs: [ciRun(), reviewRun(OLD)] }) }));
  assert.equal(r.decision, "manual_approval");
  assert.ok(codes(r).includes("review_unverified"));
});

test("revisor confiável reprovou o head atual: blocked", () => {
  const r = decideIntegration(input({ pr: pr({ check_runs: [ciRun(), reviewRun(HEAD, { conclusion: "FAILURE" })] }) }));
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("review_rejected"));
});

test("CI verde só no SHA anterior: checks não verificados no head atual, blocked", () => {
  const r = decideIntegration(input({ pr: pr({ check_runs: [ciRun(OLD), reviewRun()] }) }));
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("checks_unverified"));
});

test("check 'test' publicado por status fabricado (sem app de CI confiável): blocked", () => {
  const r = decideIntegration(input({ pr: pr({ check_runs: [ciRun(HEAD, { app_slug: null }), reviewRun()] }) }));
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("checks_unverified"));
});

test("check obrigatório faltando: blocked", () => {
  const r = decideIntegration(input({ pr: pr({ check_runs: [reviewRun()] }) }));
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("checks_unverified"));
});

test("check ainda em andamento: blocked (checks_pending)", () => {
  const r = decideIntegration(
    input({ pr: pr({ check_runs: [ciRun(HEAD, { status: "IN_PROGRESS", conclusion: null }), reviewRun()] }) }),
  );
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("checks_pending"));
});

test("check de CI falhou no head: blocked", () => {
  const r = decideIntegration(input({ pr: pr({ check_runs: [ciRun(HEAD, { conclusion: "FAILURE" }), reviewRun()] }) }));
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("check_failed"));
});

test("head divergente do SHA esperado (novo push): blocked, sem merge", () => {
  const r = decideIntegration(input({ pr: pr({ head_sha: OLD, check_runs: [ciRun(OLD), reviewRun(OLD)] }) }));
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("head_divergente"));
  assert.equal(r.merge_args, null);
});

test("branch da PR alterada em relação ao ticket: blocked", () => {
  const r = decideIntegration(input({ pr: pr({ head_ref: "outra-branch" }) }));
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("branch_unknown"));
});

test("base diferente da branch padrão protegida: blocked", () => {
  const r = decideIntegration(input({ pr: pr({ base_ref: "develop" }) }));
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("base_mismatch"));
});

test("PR draft: blocked", () => {
  const r = decideIntegration(input({ pr: pr({ is_draft: true }) }));
  assert.equal(r.decision, "blocked");
});

test("conflito de merge: blocked", () => {
  const r = decideIntegration(input({ pr: pr({ mergeable: "CONFLICTING", merge_state_status: "DIRTY" }) }));
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("not_mergeable"));
});

test("mergeStateStatus UNKNOWN ou BEHIND: blocked (fail closed)", () => {
  for (const status of ["UNKNOWN", "BEHIND", "BLOCKED"]) {
    const r = decideIntegration(input({ pr: pr({ merge_state_status: status }) }));
    assert.equal(r.decision, "blocked", status);
  }
});

test("diff incompleto (mais arquivos que o retornado pela API): blocked", () => {
  const r = decideIntegration(input({ pr: pr({ changed_files: 150 }) }));
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("diff_unavailable"));
});

test("arquivo fora do escopo do ticket: blocked", () => {
  const r = decideIntegration(
    input({ pr: pr({ files: [{ path: "docs/outro.ts", kind: "modified", additions: 1, deletions: 0 }] }) }),
  );
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("scope_drift"));
});

test("PR merged por humano ou outro evento: already_merged, sem merge", () => {
  const r = decideIntegration(input({ pr: pr({ state: "MERGED" }) }));
  assert.equal(r.decision, "already_merged");
  assert.equal(r.merge_args, null);
});

test("PR fechada sem merge: blocked", () => {
  const r = decideIntegration(input({ pr: pr({ state: "CLOSED" }) }));
  assert.equal(r.decision, "blocked");
});

test("auto-merge já habilitado para o mesmo head: already_requested", () => {
  const r = decideIntegration(input({ pr: pr({ auto_merge_enabled: true }) }));
  assert.equal(r.decision, "already_requested");
  assert.equal(r.merge_args, null);
});

test("PR desconhecida, repo desconhecido ou política ausente: blocked", () => {
  assert.equal(decideIntegration(input({ pr: null })).decision, "blocked");
  assert.equal(decideIntegration(input({ repo: null })).decision, "blocked");
  assert.equal(decideIntegration(input({ policy: null })).decision, "blocked");
});

// ---- requestIntegration: um pedido por SHA, sem repetir chamada ao gh ----

function fakeGithub(snapshot: { pr: PrSnapshot | null; repo: RepoFacts | null; protection: Protection }) {
  const calls: string[][] = [];
  let failMerge: Error | null = null;
  const github: MergeGithub = {
    snapshot: () => Promise.resolve(snapshot),
    merge: (args) => {
      calls.push(args);
      return failMerge ? Promise.reject(failMerge) : Promise.resolve("ok");
    },
  };
  return {
    github,
    calls,
    failWith(err: Error) {
      failMerge = err;
    },
  };
}

function freshStore(): IntegrationStore {
  return new IntegrationStore(mkdtempSync(join(tmpdir(), "t146-merge-")));
}

const request = (
  store: IntegrationStore,
  github: MergeGithub,
  over: Partial<Parameters<typeof requestIntegration>[0]> = {},
) =>
  requestIntegration(
    {
      repo: REPO,
      number: NUMBER,
      expected_head_sha: HEAD,
      policy: policy(),
      ticket: ticket(),
      reviewer: REVIEWER,
      ...over,
    },
    { github, store },
  );

test("requestIntegration: pedido único mesmo com eventos duplicados simultâneos", async () => {
  const fake = fakeGithub({ pr: pr(), repo: REPO_OK, protection: PROTECTED_OK });
  const store = freshStore();
  const results = await Promise.all([
    request(store, fake.github),
    request(store, fake.github),
    request(store, fake.github),
  ]);
  assert.equal(fake.calls.length, 1, "gh pr merge deve rodar uma única vez");
  assert.equal(results.filter((r) => r.decision === "merge_requested").length, 1);
  assert.ok(results.every((r) => r.decision === "merge_requested" || r.decision === "already_requested"));
});

test("requestIntegration: retry sequencial no mesmo SHA não repete o merge", async () => {
  const fake = fakeGithub({ pr: pr(), repo: REPO_OK, protection: PROTECTED_OK });
  const store = freshStore();
  await request(store, fake.github);
  const second = await request(store, fake.github);
  assert.equal(second.decision, "already_requested");
  assert.equal(fake.calls.length, 1);
});

test("requestIntegration: falha de permissão no gh gera blocked e não repete no mesmo SHA", async () => {
  const fake = fakeGithub({ pr: pr(), repo: REPO_OK, protection: PROTECTED_OK });
  fake.failWith(new Error("HTTP 403: Resource not accessible by integration"));
  const store = freshStore();
  const first = await request(store, fake.github);
  assert.equal(first.decision, "blocked");
  assert.ok(codes(first).includes("merge_request_failed"));
  const second = await request(store, fake.github);
  assert.equal(second.decision, "blocked");
  assert.ok(codes(second).includes("integration_failed_for_head"));
  assert.equal(fake.calls.length, 1);
});

test("requestIntegration: claim interrompido sem resultado bloqueia para reconciliação humana", async () => {
  const fake = fakeGithub({ pr: pr(), repo: REPO_OK, protection: PROTECTED_OK });
  const store = freshStore();
  // claim órfão de um processo que caiu antes de registrar o resultado
  writeFileSync(store.pathFor(`${REPO}#${NUMBER}@${HEAD}`), JSON.stringify({ status: "requesting", head_sha: HEAD }));
  const r = await request(store, fake.github);
  assert.equal(r.decision, "blocked");
  assert.ok(codes(r).includes("integration_interrupted"));
  assert.equal(fake.calls.length, 0);
});

test("requestIntegration: novo push (novo SHA) é elegível de novo; o SHA antigo não é reaproveitado", async () => {
  const store = freshStore();
  const first = fakeGithub({ pr: pr(), repo: REPO_OK, protection: PROTECTED_OK });
  await request(store, first.github);
  const second = fakeGithub({
    pr: pr({ head_sha: OLD, check_runs: [ciRun(OLD), reviewRun(OLD)] }),
    repo: REPO_OK,
    protection: PROTECTED_OK,
  });
  const r = await request(store, second.github, { expected_head_sha: OLD });
  assert.equal(r.decision, "merge_requested");
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0].at(-1), OLD);
});

test("requestIntegration: PR merged por humano não chama gh", async () => {
  const fake = fakeGithub({ pr: pr({ state: "MERGED" }), repo: REPO_OK, protection: PROTECTED_OK });
  const r = await request(freshStore(), fake.github);
  assert.equal(r.decision, "already_merged");
  assert.equal(fake.calls.length, 0);
});

test("requestIntegration: setup_required não chama gh nem grava claim", async () => {
  const fake = fakeGithub({
    pr: pr(),
    repo: { allow_auto_merge: false, default_branch: "master" },
    protection: PROTECTED_OK,
  });
  const store = freshStore();
  const r = await request(store, fake.github);
  assert.equal(r.decision, "setup_required");
  assert.equal(fake.calls.length, 0);
  const again = await request(store, fake.github);
  assert.equal(again.decision, "setup_required");
});

test("requestIntegration: registro persistido sem segredo em texto puro", async () => {
  const fake = fakeGithub({ pr: pr(), repo: REPO_OK, protection: PROTECTED_OK });
  fake.failWith(new Error("falhou com token ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  const store = freshStore();
  await request(store, fake.github);
  const files = readdirSync(store.dir);
  assert.equal(files.length, 1);
  const raw = readFileSync(join(store.dir, files[0]), "utf8");
  assert.equal(raw.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), false);
});

test("store: claim grava registro JSON com status requesting e não sobrescreve", () => {
  const store = freshStore();
  assert.equal(store.claim("x/y#1@" + HEAD).claimed, true);
  const second = store.claim("x/y#1@" + HEAD);
  assert.equal(second.claimed, false);
  assert.equal(second.existing?.status, "requesting");
});
