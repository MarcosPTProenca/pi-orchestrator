import { test } from "node:test";
import assert from "node:assert/strict";
import { ghMergeGithub, parsePrSnapshot, parseProtection, parseRepoFacts } from "../src/shared/merge-gate-github.ts";

const REPO = "MarcosPTProenca/pi-orchestrator";
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function graphqlPr(over: Record<string, unknown> = {}, commitOid = HEAD) {
  return {
    data: {
      repository: {
        pullRequest: {
          number: 200,
          state: "OPEN",
          isDraft: false,
          body: "Implementa o gate.\n\nCloses #146, refs #138",
          headRefName: "feat/x",
          headRefOid: HEAD,
          baseRefName: "master",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          changedFiles: 2,
          autoMergeRequest: null,
          files: {
            nodes: [
              { path: "src/worker/a.ts", changeType: "MODIFIED", additions: 3, deletions: 1 },
              { path: "src/worker/b.ts", changeType: "RENAMED", additions: 0, deletions: 0 },
            ],
          },
          commits: {
            nodes: [
              {
                commit: {
                  oid: commitOid,
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "test",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          checkSuite: { app: { slug: "github-actions" } },
                        },
                        {
                          __typename: "StatusContext",
                          context: "test",
                          state: "SUCCESS",
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
          ...over,
        },
      },
    },
  };
}

test("parsePrSnapshot: extrai head, base, issue vinculada, arquivos e identidade do check", () => {
  const s = parsePrSnapshot(graphqlPr(), REPO);
  assert.ok(s);
  assert.equal(s.head_sha, HEAD);
  assert.equal(s.base_ref, "master");
  assert.equal(s.linked_issue, 146);
  assert.equal(s.changed_files, 2);
  assert.deepEqual(
    s.files.map((f) => f.kind),
    ["modified", "renamed"],
  );
  const ci = s.check_runs.find((c) => c.app_slug === "github-actions");
  assert.ok(ci);
  assert.equal(ci.head_sha, HEAD);
});

test("parsePrSnapshot: StatusContext nunca recebe identidade de app", () => {
  const s = parsePrSnapshot(graphqlPr(), REPO);
  const status = s?.check_runs.find((c) => c.name === "test" && c.app_slug === null);
  assert.ok(status, "status fabricado deve aparecer sem app");
});

test("parsePrSnapshot: commit anexado diferente do head não gera check do head", () => {
  const s = parsePrSnapshot(graphqlPr({}, OLD), REPO);
  assert.ok(s);
  assert.equal(s.check_runs.length, 0);
});

test("parsePrSnapshot: auto-merge já ativo é detectado", () => {
  const s = parsePrSnapshot(graphqlPr({ autoMergeRequest: { enabledAt: "2026-11-23T00:00:00Z" } }), REPO);
  assert.equal(s?.auto_merge_enabled, true);
});

test("parsePrSnapshot: PR sem issue vinculada na descrição fica sem issue", () => {
  const s = parsePrSnapshot(graphqlPr({ body: "sem vínculo" }), REPO);
  assert.equal(s?.linked_issue, null);
});

test("parsePrSnapshot: resposta sem PR retorna null", () => {
  assert.equal(parsePrSnapshot({ data: { repository: { pullRequest: null } } }, REPO), null);
  assert.equal(parsePrSnapshot({}, REPO), null);
});

test("parseRepoFacts: exige allow_auto_merge booleano e branch padrão", () => {
  assert.deepEqual(parseRepoFacts({ allow_auto_merge: false, default_branch: "master" }), {
    allow_auto_merge: false,
    default_branch: "master",
  });
  assert.throws(() => parseRepoFacts({ default_branch: "master" }));
  assert.throws(() => parseRepoFacts({ allow_auto_merge: null, default_branch: "master" }));
});

test("parseProtection: lê contextos obrigatórios de checks e contexts", () => {
  const p = parseProtection({
    required_status_checks: { contexts: ["lint"], checks: [{ context: "test", app_id: 15368 }] },
  });
  assert.deepEqual(p, { status: "protected", required_contexts: ["test", "lint"] });
});

test("ghMergeGithub.merge: recusa --admin e merge sem --match-head-commit antes de chamar o gh", async () => {
  const gh = ghMergeGithub("git@example.com:neutral/repo.git", process.cwd());
  const base = ["pr", "merge", "200", "--repo", REPO, "--auto", "--squash"];
  await assert.rejects(gh.merge([...base, "--match-head-commit", HEAD, "--admin"]), /--admin/);
  await assert.rejects(gh.merge(base), /--match-head-commit/);
  await assert.rejects(gh.merge(["pr", "close", "200"]), /fora da política/);
});
