import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStream } from "../evals/run.ts";

test("parseStream extrai chamadas, resultados, tokens e modelo do stream JSON", () => {
  const lines = [
    { type: "session" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-6.1-sol",
        usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 50, totalTokens: 165 },
        content: [
          { type: "text", text: "Lançando." },
          { type: "toolCall", name: "orch_delegate", arguments: { tasks: [{ model: "m" }] } },
        ],
      },
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "orch_delegate",
        isError: true,
        content: [{ type: "text", text: "modelo indisponível: x" }],
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-6.1-sol",
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 },
        content: [{ type: "text", text: "Não lancei." }],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  const run = parseStream(lines);
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].name, "orch_delegate");
  assert.equal(run.results[0].isError, true);
  assert.equal(run.usage.total, 175);
  assert.equal(run.usage.cacheWrite, 54);
  assert.equal(run.finalText, "Não lancei.");
  assert.deepEqual([...run.models], ["openai-codex/gpt-6.1-sol"]);
});
