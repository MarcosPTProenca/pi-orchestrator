export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  costFromProvider: boolean;
}

export function newUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, costFromProvider: false };
}

export interface UsageState {
  total: Usage;
  counted: (number | string)[];
  warm?: Usage;
  warmIds?: string[];
}

interface UsageMessage {
  role?: string;
  timestamp?: number;
  responseId?: string;
  provider?: string;
  model?: string;
  usage?: Partial<Omit<Usage, "cost" | "costFromProvider">> & {
    cost?: { total?: number; totalFromProvider?: boolean };
  };
}

export function addNewUsage(total: Usage, messages: unknown[], counted: (number | string)[]): UsageState {
  const seen = new Set(counted);
  const out: Usage = { ...newUsage(), ...total };
  const ids = [...counted];
  let providerParts = total.costFromProvider === true || total.cost === 0;
  let anyCost = total.cost > 0;
  for (const m of messages as UsageMessage[]) {
    if (m?.role !== "assistant") continue;
    const key =
      typeof m.responseId === "string" && m.responseId !== ""
        ? `r:${m.responseId}`
        : typeof m.timestamp === "number"
          ? `t:${m.timestamp}:${m.provider ?? ""}:${m.model ?? ""}`
          : null;
    const legacy = typeof m.timestamp === "number" && seen.has(m.timestamp);
    if (key !== null) {
      if (seen.has(key) || legacy) continue;
      seen.add(key);
      ids.push(key);
    }
    const u = m.usage ?? {};
    out.input += u.input ?? 0;
    out.output += u.output ?? 0;
    out.cacheRead += u.cacheRead ?? 0;
    out.cacheWrite += u.cacheWrite ?? 0;
    out.totalTokens += u.totalTokens ?? 0;
    if (typeof u.cost?.total === "number") {
      out.cost += u.cost.total;
      anyCost = true;
      providerParts = providerParts && u.cost.totalFromProvider === true;
    }
  }
  out.costFromProvider = anyCost && providerParts;
  return { total: out, counted: ids };
}

interface SessionUsageEntry {
  type?: string;
  id?: string;
  kind?: string;
  usage?: Partial<Omit<Usage, "cost" | "costFromProvider">> & { cost?: { total?: number } };
}

export function addCacheWarmUsage(
  prev: { warm?: Usage; warmIds?: string[] },
  entries: unknown[],
): { warm: Usage; warmIds: string[] } {
  const out: Usage = { ...newUsage(), ...(prev.warm ?? {}) };
  const ids = [...(prev.warmIds ?? [])];
  const seen = new Set(ids);
  for (const e of entries as SessionUsageEntry[]) {
    if (e?.type !== "usage" || e.kind !== "cache_warm" || typeof e.id !== "string") continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    ids.push(e.id);
    const u = e.usage ?? {};
    out.input += u.input ?? 0;
    out.output += u.output ?? 0;
    out.cacheRead += u.cacheRead ?? 0;
    out.cacheWrite += u.cacheWrite ?? 0;
    out.totalTokens += u.totalTokens ?? 0;
    out.cost += typeof u.cost?.total === "number" ? u.cost.total : 0;
  }
  return { warm: out, warmIds: ids };
}

export function cacheHitRatio(u: Pick<Usage, "input" | "cacheRead" | "cacheWrite">): number | null {
  const denom = u.input + u.cacheRead + u.cacheWrite;
  return denom > 0 ? u.cacheRead / denom : null;
}
