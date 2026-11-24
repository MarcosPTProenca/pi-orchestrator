import type { CacheWarmingDecisionEventResult } from "@earendil-works/pi-coding-agent";

/** Variável lida pelo orquestrador. Só o valor "off" sobrepõe a decisão do Pi. */
export const CACHE_WARMING_ENV = "PI_ORCH_CACHE_WARMING";

/**
 * Resultado do hook `cache_warming_decision` restrito ao processo do orquestrador.
 * Não altera `cacheWarming` nas configurações globais (~/.pi/agent) nem os workers.
 */
export function cacheWarmingOverride(
  env: NodeJS.ProcessEnv = process.env,
): CacheWarmingDecisionEventResult | undefined {
  return env[CACHE_WARMING_ENV] === "off" ? { action: "stop" } : undefined;
}
