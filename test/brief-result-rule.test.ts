import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildIntake, renderBrief, MODES } from "../src/shared/intake.ts";

function project(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "brief-result-rule-")), "proj");
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

test("brief proíbe segunda pessoa dentro de result e manda pendência para question, em todos os modos", () => {
  for (const mode of MODES) {
    const brief = renderBrief(
      "t-x",
      buildIntake({ project_path: project(), role: "a", request: "x", objective: "y", mode }),
      "/r.json",
    );
    assert.match(brief, /^8\. O campo result é texto para o ORQUESTRADOR ler/m, `modo ${mode}`);
    assert.match(brief, /Nunca se dirija ao usuário em segunda pessoa dentro de result/, `modo ${mode}`);
    assert.match(
      brief,
      /campo question com status blocked, não escrita dentro de result de status done/,
      `modo ${mode}`,
    );
  }
});
