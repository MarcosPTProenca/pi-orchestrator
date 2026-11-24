import type { CacheWarmingDecisionEventResult } from "@earendil-works/pi-coding-agent";

export const CACHE_WARMING_ENV = "PI_ORCH_CACHE_WARMING";

export function cacheWarmingOverride(
  env: NodeJS.ProcessEnv = process.env,
): CacheWarmingDecisionEventResult | undefined {
  return env[CACHE_WARMING_ENV] === "off" ? { action: "stop" } : undefined;
}
