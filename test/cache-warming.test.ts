import assert from "node:assert/strict";
import { test } from "node:test";
import { CACHE_WARMING_ENV, cacheWarmingOverride } from "../src/orchestrator/cache-warming.ts";

test("sem variável, o orquestrador mantém a decisão do Pi", () => {
  assert.equal(cacheWarmingOverride({}), undefined);
});

test("PI_ORCH_CACHE_WARMING=off faz o orquestrador parar o aquecimento", () => {
  assert.deepEqual(cacheWarmingOverride({ [CACHE_WARMING_ENV]: "off" }), { action: "stop" });
});

test("valores diferentes de off não alteram a decisão do Pi", () => {
  for (const value of ["idle", "streaming", "", "OFF", "0"]) {
    assert.equal(cacheWarmingOverride({ [CACHE_WARMING_ENV]: value }), undefined, value);
  }
});
