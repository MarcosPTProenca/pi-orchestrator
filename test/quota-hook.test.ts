import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQuota, pickModel, checkRequestedQuota, DEFAULT_PRIORITY, quotaProviderOf } from "../src/quota.ts";
import { fallbackReportFor, lastModelError } from "../src/fallback.ts";
import { startHook, postToHook } from "../src/hook.ts";
import { makeHarness, writeReport } from "./fakes.ts";

const AVAIL = ["claude-bridge/claude-haiku-5-5", "openai-codex/gpt-6-luna", "kiro/auto"];
const q = (provider: string, pct: number | null) => ({ provider, percentRemaining: pct, stale: false });

test("ordem padrão: haiku (claude), luna (codex), kiro/auto por último", () => {
  assert.deepEqual([...DEFAULT_PRIORITY], ["claude-bridge/claude-haiku-5-5", "openai-codex/gpt-6-luna", "kiro/auto"]);
  assert.equal(quotaProviderOf("claude-bridge/claude-haiku-5-5"), "claude");
  assert.equal(quotaProviderOf("openai-codex/gpt-6-luna"), "codex");
  assert.equal(quotaProviderOf("kiro/auto"), "kiro");
});

test("escolhe haiku enquanto a cota do Claude está acima do mínimo", () => {
  const r = pickModel(DEFAULT_PRIORITY, [q("claude", 59), q("codex", 80)], AVAIL);
  assert.equal(r.model, "claude-bridge/claude-haiku-5-5");
  assert.match(r.reason, /cota claude 59%/);
});

test("Claude sem cota: cai para luna 6 do Codex", () => {
  const r = pickModel(DEFAULT_PRIORITY, [q("claude", 4), q("codex", 80)], AVAIL);
  assert.equal(r.model, "openai-codex/gpt-6-luna");
});

test("sem cota em Claude nem Codex: kiro/auto como último recurso", () => {
  const r = pickModel(DEFAULT_PRIORITY, [q("claude", 0), q("codex", 2)], AVAIL);
  assert.equal(r.model, "kiro/auto");
  assert.match(r.reason, /último recurso/);
});

test("cota desconhecida não conta como disponível; sem nenhum modelo, erro explícito", () => {
  const r = pickModel(DEFAULT_PRIORITY, [q("claude", null), q("codex", 50)], AVAIL);
  assert.equal(r.model, "openai-codex/gpt-6-luna");
  assert.throws(() => pickModel(["claude-bridge/claude-haiku-5-5"], [q("claude", 1)], AVAIL), /nenhum modelo com cota disponível/);
});

test("modelo pedido com cota esgotada é recusado, sem troca", () => {
  assert.throws(() => checkRequestedQuota("claude-bridge/claude-haiku-5-5", [q("claude", 3)]), /cota de claude esgotada.*não foi lançado/);
  assert.doesNotThrow(() => checkRequestedQuota("claude-bridge/claude-haiku-5-5", [q("claude", 40)]));
  assert.doesNotThrow(() => checkRequestedQuota("kiro/auto", [q("claude", 0)]));
});

test("parseQuota usa o menor percentual efetivo e marca stale", () => {
  const json = { providers: [
    { provider: "claude", state: { stale: true }, quotaSemantics: { effectiveAvailability: [{ scope: "all_models", effectivePercentRemaining: 59 }] }, windows: [{ percentRemaining: 59 }, { percentRemaining: 72 }] },
    { provider: "codex", windows: [{ percentRemaining: 30 }, { percentRemaining: 12 }] },
  ] };
  const r = parseQuota(json);
  assert.deepEqual(r.map((x) => [x.provider, x.percentRemaining, x.stale]), [["claude", 59, true], ["codex", 12, false]]);
});

test("relatório de falha distingue cota de outros erros do modelo", () => {
  const quotaMsg = [{ role: "assistant", errorMessage: "429 rate limit exceeded for claude" }];
  assert.match(fallbackReportFor("t-1", quotaMsg, "now").result, /Cota esgotada/);
  const other = [{ role: "assistant", errorMessage: "network reset" }];
  assert.match(fallbackReportFor("t-1", other, "now").result, /erro do modelo/);
  assert.match(fallbackReportFor("t-1", [], "now").result, /sem chamar orch_report/);
  assert.equal(lastModelError([{ role: "user" }, { role: "assistant", errorMessage: "x" }]), "x");
});

test("webhook: sem token é 401; corpo inválido é 400; POST válido chama o handler", async () => {
  const seen: string[] = [];
  const hook = await startHook("tok", async (id) => { seen.push(id); });
  try {
    const noAuth = await fetch(hook.url, { method: "POST", body: JSON.stringify({ task_id: "t-1" }) });
    assert.equal(noAuth.status, 401);
    const bad = await fetch(hook.url, { method: "POST", headers: { authorization: "Bearer tok" }, body: "não é json" });
    assert.equal(bad.status, 400);
    assert.equal(await postToHook(hook.url, "tok", "t-9"), true);
    assert.equal(await postToHook(hook.url, "errado", "t-9"), false);
    assert.deepEqual(seen, ["t-9"]);
  } finally {
    hook.close();
  }
});

test("worker não quebra se o orquestrador está fora do ar: POST falha sem lançar", async () => {
  const hook = await startHook("tok", async () => undefined);
  const url = hook.url;
  hook.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await postToHook(url, "tok", "t-1"), false);
});

test("orquestrador: escolha de modelo que falha impede o lançamento de qualquer worker", async () => {
  const h = makeHarness();
  const { Orchestrator } = await import("../src/orchestrator.ts");
  const { Store } = await import("../src/store.ts");
  const orch = new Orchestrator({
    herdr: h.herdr, store: new Store(join(h.stateDir, "q.json")), tasksDir: join(h.stateDir, "q-tasks"),
    workerExtPath: "/x", now: () => h.clock.ms, newHex: () => "abababab",
    availableModels: () => AVAIL, dryRun: false,
    chooseModel: async () => { throw new Error("cota esgotada (teste)"); },
  });
  await assert.rejects(orch.delegate({ project_path: h.project, role: "a", request: "x", objective: "y", mode: "report" }), /cota esgotada/);
  assert.equal(h.herdr.opsOf("createTab").length, 0);
  assert.equal(orch.list().length, 0);
});
