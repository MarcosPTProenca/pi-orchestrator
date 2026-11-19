import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MODES, buildIntake } from "../src/intake.ts";
import { judgeDone } from "../src/verify.ts";

function project(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "intake-modes-")), "proj");
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

const base = { role: "a", request: "x", objective: "y" };

test("local-only não é mais um modo de lançamento", () => {
  assert.deepEqual([...MODES], ["report", "direct-pr", "design"]);
  assert.throws(
    () => buildIntake({ ...base, project_path: project(), mode: "local-only" as never }),
    /mode inválido: local-only/,
  );
});

test("direct-pr e report continuam aceitos", () => {
  assert.equal(buildIntake({ ...base, project_path: project(), mode: "direct-pr" }).mode, "direct-pr");
  assert.equal(buildIntake({ ...base, project_path: project(), mode: "report" }).mode, "report");
});

test("tarefa legada local-only continua verificável pelo SHA do commit", async () => {
  const env = { prCheck: async () => ({ ok: true, line: "" }), commitExists: () => true, pathExists: () => true };
  const v = await judgeDone("local-only", "done", ["commit 3b4ac36"], env);
  assert.equal(v.verdict, "approved");
});
