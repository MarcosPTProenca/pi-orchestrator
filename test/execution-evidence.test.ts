import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCommand,
  appendMark,
  buildEvidence,
  EVIDENCE_FILE,
  readEvidenceLog,
  skillLoaded,
  tddCheck,
  writeEvidence,
  type CommandRecord,
  type EvidenceInput,
  type EvidenceLog,
} from "../src/shared/execution-evidence.ts";

const cmd = (command: string, exit_code: number | null): CommandRecord => ({
  command,
  exit_code,
  at: "2026-11-23T00:00:00.000Z",
  excerpt: "",
});

const logOf = (commands: CommandRecord[], marks: EvidenceLog["marks"]): EvidenceLog => ({ commands, marks });

test("TDD: red com exit != 0 antes de green com exit 0 vira par válido por seam", () => {
  const log = logOf(
    [cmd("node --test a.test.ts", 1), cmd("edit", null), cmd("node --test a.test.ts", 0)],
    [
      { seam: "S1", phase: "red", command_index: 0 },
      { seam: "S1", phase: "green", command_index: 2 },
    ],
  );
  const r = tddCheck(log, ["S1"]);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.seams, [
    {
      seam: "S1",
      red: { command_index: 0, command: "node --test a.test.ts", exit_code: 1 },
      green: { command_index: 2, command: "node --test a.test.ts", exit_code: 0 },
    },
  ]);
});

test("TDD: red que passou não prova nada; green que falhou não vale", () => {
  const passedRed = logOf(
    [cmd("t", 0), cmd("t", 0)],
    [
      { seam: "S1", phase: "red", command_index: 0 },
      { seam: "S1", phase: "green", command_index: 1 },
    ],
  );
  assert.match(tddCheck(passedRed, ["S1"]).problems.join(";"), /S1.*red.*não falhou/);
  const redGreenFail = logOf(
    [cmd("t", 1), cmd("t", 1)],
    [
      { seam: "S1", phase: "red", command_index: 0 },
      { seam: "S1", phase: "green", command_index: 1 },
    ],
  );
  assert.match(tddCheck(redGreenFail, ["S1"]).problems.join(";"), /S1.*green.*não passou/);
});

test("TDD: green antes de red, marca ausente ou exit desconhecido são problemas", () => {
  const reversed = logOf(
    [cmd("t", 0), cmd("t", 1)],
    [
      { seam: "S1", phase: "red", command_index: 1 },
      { seam: "S1", phase: "green", command_index: 0 },
    ],
  );
  assert.ok(tddCheck(reversed, ["S1"]).problems.length > 0);
  assert.match(tddCheck(logOf([], []), ["S2"]).problems.join(";"), /S2.*sem red/);
  const unknownExit = logOf(
    [cmd("t", null), cmd("t", 0)],
    [
      { seam: "S1", phase: "red", command_index: 0 },
      { seam: "S1", phase: "green", command_index: 1 },
    ],
  );
  assert.ok(tddCheck(unknownExit, ["S1"]).problems.length > 0);
});

test("skillLoaded acha o bloco <skill name=...> só na mensagem do usuário", () => {
  const block = '<skill name="implement" location="/x/SKILL.md">\nbody\n</skill>\n\nLeia o brief';
  const userText = { type: "message", message: { role: "user", content: block } };
  const userParts = {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: block }] },
  };
  const assistant = { type: "message", message: { role: "assistant", content: block } };
  assert.equal(skillLoaded([userText], "implement"), true);
  assert.equal(skillLoaded([userParts], "implement"), true);
  assert.equal(skillLoaded([assistant], "implement"), false);
  assert.equal(skillLoaded([userText], "ponytail"), false);
  assert.equal(skillLoaded([{ type: "custom" }], "implement"), false);
});

const input = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  task_id: "t-1",
  attempt_id: "a-1",
  kind: "bug",
  versions: { node: "v22", pi: "1.5.2", implement_skill_sha256: "abc" },
  skill_loaded: true,
  publish: {
    task_id: "t-1",
    attempt_id: "a-1",
    branch: "feat/x",
    base_sha: "b0",
    head_sha: "h1",
    pushed_sha: "h1",
    pr_url: "https://github.com/o/r/pull/9",
  },
  log: logOf(
    [cmd("t", 1), cmd("t", 0)],
    [
      { seam: "S1", phase: "red", command_index: 0 },
      { seam: "S1", phase: "green", command_index: 1 },
    ],
  ),
  seams: ["S1"],
  steps: ["S1", "S2"],
  deviations: [],
  base_sha: "b0",
  head_sha: "h1",
  ...over,
});

test("buildEvidence fica completo com skill carregada, TDD válido e publicação", () => {
  const e = buildEvidence(input());
  assert.equal(e.complete, true);
  assert.deepEqual(e.missing, []);
  assert.deepEqual(e.skill, { name: "implement", loaded: true });
  assert.equal(e.publish?.pr_url, "https://github.com/o/r/pull/9");
  assert.equal(e.tdd.applicable, true);
  assert.equal(e.tdd.seams.length, 1);
  assert.equal(e.commands.length, 2);
});

test("buildEvidence aponta o que falta: skill ausente, TDD ausente em bug/feature", () => {
  const noSkill = buildEvidence(input({ skill_loaded: false }));
  assert.equal(noSkill.complete, false);
  assert.match(noSkill.missing.join(";"), /skill implement não carregada/);
  const noSeams = buildEvidence(input({ seams: [], log: logOf([], []) }));
  assert.equal(noSeams.complete, false);
  assert.match(noSeams.missing.join(";"), /sem test seams/);
});

test("mudança sem comportamento (docs) não exige TDD, e a evidência diz que não se aplica", () => {
  const e = buildEvidence(input({ kind: "change", seams: [], log: logOf([], []) }));
  assert.equal(e.tdd.applicable, false);
  assert.equal(e.complete, true);
});

test("arquivos de evidência persistem na pasta da tarefa", () => {
  const dir = mkdtempSync(join(tmpdir(), "evid-"));
  try {
    appendCommand(dir, cmd("node --test a.test.ts", 1));
    appendMark(dir, { seam: "S1", phase: "red", command_index: 0 });
    const log = readEvidenceLog(dir);
    assert.equal(log.commands.length, 1);
    assert.deepEqual(log.marks, [{ seam: "S1", phase: "red", command_index: 0 }]);
    writeEvidence(dir, buildEvidence(input({ log })));
    const written = JSON.parse(readFileSync(join(dir, EVIDENCE_FILE), "utf8")) as { complete: boolean };
    assert.equal(typeof written.complete, "boolean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
