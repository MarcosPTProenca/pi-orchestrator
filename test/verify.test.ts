import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeDone, type VerifyEnv } from "../src/orchestrator/verify.ts";

const PR = "https://github.com/o/r/pull/7";
type EvidenceFixture = {
  commands: { command: string; exit_code: number }[];
  tdd: { applicable: boolean; seams: unknown[] };
};
function withTicket<T>(fn: (taskDir: string) => Promise<T>): Promise<T> {
  const taskDir = mkdtempSync(join(tmpdir(), "verify-evidence-"));
  writeFileSync(
    join(taskDir, "ticket.json"),
    JSON.stringify({ task_id: "t-1", attempt_id: "a-1", validation: { commands: ["npm test", "npm run lint"] } }),
  );
  return fn(taskDir).finally(() => rmSync(taskDir, { recursive: true, force: true }));
}

function withEvidence<T>(fn: (taskDir: string) => Promise<T>): Promise<T> {
  return withTicket(async (taskDir) => {
    writeFileSync(
      join(taskDir, "execution-evidence.json"),
      JSON.stringify({
        schema_version: 1,
        task_id: "t-1",
        attempt_id: "a-1",
        complete: true,
        commands: [
          { command: "npm test", exit_code: 0 },
          { command: "npm run lint", exit_code: 0 },
        ],
        tdd: { applicable: false, seams: [] },
      }),
    );
    return fn(taskDir);
  });
}
const ok = { prCheck: () => Promise.resolve({ ok: true, line: "Verificação da PR #7: VERIFICADA." }) };
const bad = {
  prCheck: () => Promise.resolve({ ok: false, line: "Verificação da PR #7: NÃO VERIFICADA. checks falhando." }),
};
function env(over: Partial<VerifyEnv> = {}): VerifyEnv {
  return {
    prCheck: ok.prCheck,
    commitExists: () => true,
    pathExists: () => true,
    ...over,
  };
}

test("status diferente de done não é conferido", async () => {
  const v = await judgeDone("direct-pr", "failed", [], env());
  assert.equal(v.verdict, "not_applicable");
});

test("direct-pr done sem URL de PR é reprovado", async () => {
  const v = await judgeDone("direct-pr", "done", [], env());
  assert.equal(v.verdict, "rejected");
  assert.match(v.reason, /sem PR/);
});

test("direct-pr com evidência válida e PR verificada é aprovado", async () => {
  await withEvidence(async (taskDir) => {
    const v = await judgeDone("direct-pr", "done", [PR], { ...env(ok), taskDir });
    assert.equal(v.verdict, "approved");
  });
});
test("direct-pr com ticket.json e sem evidência de execução é reprovado", async () => {
  await withTicket(async (taskDir) => {
    const v = await judgeDone("direct-pr", "done", [PR], { ...env(ok), taskDir });
    assert.equal(v.verdict, "rejected");
    assert.match(v.reason, /execution-evidence/);
  });
});
test("direct-pr sem ticket.json preserva o gate legado de PR", async () => {
  assert.equal((await judgeDone("direct-pr", "done", [PR], env(ok))).verdict, "approved");
});
test("direct-pr aceita TDD red→green declarado no plano", async () => {
  await withEvidence(async (taskDir) => {
    writeFileSync(join(taskDir, "implementation-plan.json"), JSON.stringify({ test_seams: [{ name: "S1" }] }));
    const file = join(taskDir, "execution-evidence.json");
    const evidence = JSON.parse(readFileSync(file, "utf8")) as EvidenceFixture;
    evidence.commands.unshift({ command: "node --test slice.test.ts", exit_code: 1 });
    evidence.commands.splice(1, 0, { command: "node --test slice.test.ts", exit_code: 0 });
    evidence.tdd = {
      applicable: true,
      seams: [
        {
          seam: "S1",
          red: { command_index: 0, command: "node --test slice.test.ts", exit_code: 1 },
          green: { command_index: 1, command: "node --test slice.test.ts", exit_code: 0 },
        },
      ],
    };
    writeFileSync(file, JSON.stringify(evidence));
    const v = await judgeDone("direct-pr", "done", [PR], { ...env(ok), taskDir });
    assert.equal(v.verdict, "approved");
  });
});
test("direct-pr rejeita validações sem exit 0 e TDD incompleto", async () => {
  await withEvidence(async (taskDir) => {
    const file = join(taskDir, "execution-evidence.json");
    const evidence = JSON.parse(readFileSync(file, "utf8")) as EvidenceFixture;
    evidence.commands[0].exit_code = 1;
    evidence.tdd = { applicable: true, seams: [] };
    writeFileSync(file, JSON.stringify(evidence));
    writeFileSync(join(taskDir, "implementation-plan.json"), JSON.stringify({ test_seams: [{ name: "S1" }] }));
    const v = await judgeDone("direct-pr", "done", [PR], { ...env(ok), taskDir });
    assert.equal(v.verdict, "rejected");
    assert.match(v.reason, /npm test/);
    assert.match(v.reason, /TDD/);
  });
});
test("direct-pr com PR verificada é aprovado; com PR não verificada é reprovado", async () => {
  await withEvidence(async (taskDir) => {
    assert.equal((await judgeDone("direct-pr", "done", [PR], { ...env(ok), taskDir })).verdict, "approved");
  });
  await withEvidence(async (taskDir) => {
    const v = await judgeDone("direct-pr", "done", [PR], { ...env(bad), taskDir });
    assert.equal(v.verdict, "rejected");
    assert.match(v.reason, /NÃO VERIFICADA/);
  });
});

test("falha ao consultar a PR vira não verificada, nunca aprovada", async () => {
  await withEvidence(async (taskDir) => {
    const v = await judgeDone("direct-pr", "done", [PR], {
      ...env({
        prCheck: () => Promise.reject(new Error("gh fora")),
      }),
      taskDir,
    });
    assert.equal(v.verdict, "unverified");
    assert.notEqual(v.verdict, "approved");
  });
});

test("local-only sem commit informado é reprovado; com SHA que existe é aprovado; SHA inexistente é reprovado", async () => {
  assert.equal((await judgeDone("local-only", "done", [], env())).verdict, "rejected");
  assert.equal((await judgeDone("local-only", "done", ["commit 3b4ac36 na branch fm/x"], env())).verdict, "approved");
  assert.equal(
    (await judgeDone("local-only", "done", ["3b4ac36"], env({ commitExists: () => false }))).verdict,
    "rejected",
  );
});

test("local-only: falha ao ler o repositório vira não verificada", async () => {
  const v = await judgeDone(
    "local-only",
    "done",
    ["3b4ac36"],
    env({
      commitExists: () => {
        throw new Error("git fora");
      },
    }),
  );
  assert.equal(v.verdict, "unverified");
});

test("report: artefato de caminho que não existe reprova; sem artefato não se aplica", async () => {
  assert.equal(
    (await judgeDone("report", "done", ["/tmp/nao-existe.md"], env({ pathExists: () => false }))).verdict,
    "rejected",
  );
  assert.equal((await judgeDone("report", "done", ["/tmp/ok.md"], env())).verdict, "approved");
  assert.equal((await judgeDone("report", "done", [], env())).verdict, "not_applicable");
});

test("design não tem verificação determinística", async () => {
  assert.equal((await judgeDone("design", "done", [], env())).verdict, "not_applicable");
});

test("local-only: palavra hexadecimal na prosa não reprova se um commit real está citado", async () => {
  const exists = (s: string) => s === "3b4ac36";
  const v = await judgeDone(
    "local-only",
    "done",
    ["Ajustado em 3b4ac36; cache deadbeef na nota"],
    env({ commitExists: exists }),
  );
  assert.equal(v.verdict, "approved");
});

test("local-only: nenhum SHA existe é reprovado mesmo com várias palavras hexadecimais", async () => {
  const v = await judgeDone("local-only", "done", ["deadbeef cafebabe"], env({ commitExists: () => false }));
  assert.equal(v.verdict, "rejected");
});
