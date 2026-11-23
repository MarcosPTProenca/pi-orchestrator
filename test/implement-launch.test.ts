import { test } from "node:test";
import assert from "node:assert/strict";
import { launchMessage } from "../src/shared/launch.ts";

const BRIEF = "/tmp/t-1/brief.md";

test("direct-pr aciona a skill implement pelo comando /skill: do Pi, antes do brief", () => {
  const msg = launchMessage(BRIEF, false, "direct-pr");
  assert.match(msg, /^\/skill:implement /);
  assert.match(msg, /Leia o brief em \/tmp\/t-1\/brief\.md com a ferramenta read/);
});

test("retomada de direct-pr também aciona a skill", () => {
  const msg = launchMessage(BRIEF, true, "direct-pr");
  assert.match(msg, /^\/skill:implement /);
  assert.match(msg, /Continue a tarefa do brief/);
});

test("report e design não acionam implement", () => {
  assert.doesNotMatch(launchMessage(BRIEF, false, "report"), /\/skill:/);
  assert.doesNotMatch(launchMessage(BRIEF, false, "design"), /\/skill:/);
});
