export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export function newUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

interface UsageMessage {
  role?: string;
  timestamp?: number;
  usage?: Partial<Usage>;
}

export function addNewUsage(total: Usage, messages: unknown[], counted: number[]): { total: Usage; counted: number[] } {
  const seen = new Set(counted);
  const out = { ...total };
  const ids = [...counted];
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
  }
  return { total: out, counted: ids };
}
