import { test } from "node:test";
import assert from "node:assert/strict";
import { stallNoticeFor } from "../src/stall.ts";

test("aviso de worker parado é informativo: diz que não acionou turno e não manda decidir", () => {
  const msg = stallNoticeFor([{ task_id: "t-1", project_id: "p" }], 15, () => "projeto");
  assert.match(msg, /nenhum turno foi acionado/);
  assert.doesNotMatch(msg, /decida/);
});
