import { cacheHitRatio, newUsage, type Usage } from "./usage.ts";

export interface UsageRow {
  model: string | null;
  usage: Partial<Usage> | null | undefined;
}

interface ModelTotals {
  tasks: number;
  totalTokens: number;
  cost: number;
  cache_hit_ratio: number | null;
}

export interface UsageSummary {
  tasks_with_usage: number;
  tasks_without_usage: number;
  totals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
  };
  cache_hit_ratio: number | null;
  cost_reported_by_provider: number;
  cost_estimated: number;
  by_model: Record<string, ModelTotals>;
}

export function summarizeUsage(rows: UsageRow[]): UsageSummary {
  const totals = newUsage();
  const byModel: Record<string, ModelTotals & { usage: Usage }> = {};
  let withUsage = 0;
  let reported = 0;
  let estimated = 0;
  for (const row of rows) {
    if (!row.usage) continue;
    withUsage++;
    const u: Usage = { ...newUsage(), ...row.usage };
    totals.input += u.input;
    totals.output += u.output;
    totals.cacheRead += u.cacheRead;
    totals.cacheWrite += u.cacheWrite;
    totals.totalTokens += u.totalTokens;
    totals.cost += u.cost;
    if (u.costFromProvider === true) reported += u.cost;
    else estimated += u.cost;
    const key = row.model ?? "<sem modelo>";
    const slot = (byModel[key] ??= { tasks: 0, totalTokens: 0, cost: 0, cache_hit_ratio: null, usage: newUsage() });
    slot.tasks++;
    slot.totalTokens += u.totalTokens;
    slot.cost += u.cost;
    slot.usage.input += u.input;
    slot.usage.cacheRead += u.cacheRead;
    slot.usage.cacheWrite += u.cacheWrite;
  }
  const models: Record<string, ModelTotals> = {};
  for (const [key, slot] of Object.entries(byModel)) {
    models[key] = {
      tasks: slot.tasks,
      totalTokens: slot.totalTokens,
      cost: slot.cost,
      cache_hit_ratio: cacheHitRatio(slot.usage),
    };
  }
  return {
    tasks_with_usage: withUsage,
    tasks_without_usage: rows.length - withUsage,
    totals: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      totalTokens: totals.totalTokens,
      cost: totals.cost,
    },
    cache_hit_ratio: cacheHitRatio(totals),
    cost_reported_by_provider: reported,
    cost_estimated: estimated,
    by_model: models,
  };
}
