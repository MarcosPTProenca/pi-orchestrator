import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const fixture = (f: string) => `test/fixtures/usage-real-pi/${f}`;

test("CLI imprime relatório JSON das sessões passadas, sem conteúdo de prompt", async () => {
  const { stdout } = await run(process.execPath, [
    "--import",
    "tsx",
    "scripts/usage-report.ts",
    fixture("sessao-principal.jsonl"),
    fixture("sessao-fork.jsonl"),
  ]);
  const r = JSON.parse(stdout) as {
    sessions: number;
    turns: { turns: number };
    cache: { denominator: number };
    cost_usd: number;
  };
  assert.equal(r.sessions, 2);
  assert.ok(r.turns.turns > 0);
  assert.ok(r.cache.denominator > 0);
  assert.match(stdout, /cache\.hit_ratio = cacheRead \/ cache\.denominator/);
  assert.equal(stdout.includes("status?"), false);
  assert.equal(stdout.includes("continua"), false);
});

test("CLI sem argumentos sai com código 2 e explica o uso", async () => {
  await assert.rejects(
    run(process.execPath, ["--import", "tsx", "scripts/usage-report.ts"]),
    (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /uso: usage-report/);
      return true;
    },
  );
});
