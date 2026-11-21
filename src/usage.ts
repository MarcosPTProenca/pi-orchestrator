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

interface UsageMessage {
  role?: string;
  timestamp?: number;
  usage?: Partial<Omit<Usage, "cost" | "costFromProvider">> & {
    cost?: { total?: number; totalFromProvider?: boolean };
  };
}

export function addNewUsage(total: Usage, messages: unknown[], counted: number[]): { total: Usage; counted: number[] } {
  const seen = new Set(counted);
  const out: Usage = { ...newUsage(), ...total };
  const ids = [...counted];
  let providerParts = total.costFromProvider === true || total.cost === 0;
  let anyCost = total.cost > 0;
  for (const m of messages as UsageMessage[]) {
    if (m?.role !== "assistant") continue;
    if (typeof m.timestamp === "number") {
      if (seen.has(m.timestamp)) continue;
      seen.add(m.timestamp);
      ids.push(m.timestamp);
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

export function cacheHitRatio(u: Pick<Usage, "input" | "cacheRead" | "cacheWrite">): number | null {
  const denom = u.input + u.cacheRead + u.cacheWrite;
  return denom > 0 ? u.cacheRead / denom : null;
}
