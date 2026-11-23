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

export const TRIGGER_UNAVAILABLE = "indisponivel";

export interface TurnRecord {
  trigger?: string;
  provider: string | null;
  model: string | null;
  durationMs: number | null;
  ok: boolean | null;
  totalTokens: number;
  cost: number;
}

export interface UsageState {
  total: Usage;
  counted: (number | string)[];
  warm?: Usage;
  warmIds?: string[];
  turns?: TurnRecord[];
}

interface UsageMessage {
  role?: string;
  customType?: string;
  timestamp?: number;
  responseId?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  stopReason?: string;
  usage?: Partial<Omit<Usage, "cost" | "costFromProvider">> & {
    cost?: { total?: number; totalFromProvider?: boolean };
  };
}

export function addNewUsage(
  total: Usage,
  messages: unknown[],
  counted: (number | string)[],
  prevTurns: TurnRecord[] = [],
): UsageState {
  const seen = new Set(counted);
  const out: Usage = { ...newUsage(), ...total };
  const ids = [...counted];
  const turns = [...prevTurns];
  let trigger = TRIGGER_UNAVAILABLE;
  let providerParts = total.costFromProvider === true || total.cost === 0;
  let anyCost = total.cost > 0;
  for (const m of messages as UsageMessage[]) {
    if (m?.role === "user") trigger = "mensagem-de-usuario";
    else if (m?.role === "toolResult") trigger = "ferramenta";
    else if (m?.role === "custom") trigger = `extensao:${m.customType ?? "desconhecida"}`;
    if (m?.role !== "assistant") continue;
    const turnTrigger = trigger;
    trigger = TRIGGER_UNAVAILABLE;
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
    turns.push({
      trigger: turnTrigger,
      provider: m.provider ?? null,
      model: m.model ?? null,
      durationMs: typeof m.durationMs === "number" ? m.durationMs : null,
      ok: m.stopReason === undefined ? null : m.stopReason !== "error" && m.stopReason !== "aborted",
      totalTokens: u.totalTokens ?? 0,
      cost: typeof u.cost?.total === "number" ? u.cost.total : 0,
    });
  }
  out.costFromProvider = anyCost && providerParts;
  return { total: out, counted: ids, turns };
}

export function turnsFromState(prev: UsageState): TurnRecord[] | null {
  if (prev.turns !== undefined) return prev.turns;
  return (prev.counted ?? []).length > 0 ? null : [];
}

export interface TurnSummary {
  turns: number;
  failed: number;
  unknown_status: number;
  duration_ms_total: number;
  duration_samples: number;
  cost: number;
  by_model: Record<string, number>;
  by_trigger: Record<string, number>;
}

export function entriesToMessages(entries: unknown[]): unknown[] {
  return (entries as { type?: string; message?: unknown; customType?: string }[]).flatMap((e) => {
    if (e?.type === "message") return [e.message];
    if (e?.type === "custom_message") return [{ role: "custom", customType: e.customType }];
    return [];
  });
}

function sessionUsage(entries: unknown[]): {
  total: Usage;
  turns: TurnRecord[];
  warm: Usage;
} {
  const state = addNewUsage(newUsage(), entriesToMessages(entries), []);
  return { total: state.total, turns: state.turns ?? [], warm: addCacheWarmUsage({}, entries).warm };
}

export function orchestratorUsage(entries: unknown[]): {
  origin: typeof TRIGGER_UNAVAILABLE;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  cacheWarmCost: number;
  turns: TurnSummary;
} {
  const r = sessionUsage(entries);
  return {
    origin: TRIGGER_UNAVAILABLE,
    input: r.total.input,
    output: r.total.output,
    cacheRead: r.total.cacheRead,
    cacheWrite: r.total.cacheWrite,
    totalTokens: r.total.totalTokens,
    cost: r.total.cost,
    cacheWarmCost: r.warm.cost,
    turns: summarizeTurns(r.turns),
  };
}

export function summarizeTurns(turns: TurnRecord[]): TurnSummary {
  const s: TurnSummary = {
    turns: 0,
    failed: 0,
    unknown_status: 0,
    duration_ms_total: 0,
    duration_samples: 0,
    cost: 0,
    by_model: {},
    by_trigger: {},
  };
  for (const t of turns) {
    s.turns++;
    s.cost += t.cost;
    if (t.ok === false) s.failed++;
    if (t.ok === null) s.unknown_status++;
    if (t.durationMs !== null) {
      s.duration_ms_total += t.durationMs;
      s.duration_samples++;
    }
    const key = t.model ?? "desconhecido";
    s.by_model[key] = (s.by_model[key] ?? 0) + 1;
    const trig = t.trigger ?? TRIGGER_UNAVAILABLE;
    s.by_trigger[trig] = (s.by_trigger[trig] ?? 0) + 1;
  }
  return s;
}

export function mergeTurnSummaries(list: (TurnSummary | null | undefined)[]): TurnSummary | null {
  const present = list.filter((x): x is TurnSummary => x !== null && x !== undefined);
  if (present.length === 0) return null;
  const m: TurnSummary = {
    turns: 0,
    failed: 0,
    unknown_status: 0,
    duration_ms_total: 0,
    duration_samples: 0,
    cost: 0,
    by_model: {},
    by_trigger: {},
  };
  for (const s of present) {
    for (const [k, v] of Object.entries(s.by_trigger ?? {})) m.by_trigger[k] = (m.by_trigger[k] ?? 0) + v;
    m.cost += s.cost;
    m.turns += s.turns;
    m.failed += s.failed;
    m.unknown_status += s.unknown_status;
    m.duration_ms_total += s.duration_ms_total;
    m.duration_samples += s.duration_samples;
    for (const [k, v] of Object.entries(s.by_model)) m.by_model[k] = (m.by_model[k] ?? 0) + v;
  }
  return m;
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

export type TurnOrigin = "automatico" | "usuario" | "indisponivel";

export function turnClass(trigger: string | undefined): TurnOrigin {
  if (trigger === "mensagem-de-usuario") return "usuario";
  if (trigger === "ferramenta" || trigger?.startsWith("extensao:")) return "automatico";
  return "indisponivel";
}

export function usageReport(sessions: unknown[][]) {
  let state: UsageState = { total: newUsage(), counted: [], turns: [] };
  let warm: { warm: Usage; warmIds: string[] } = { warm: newUsage(), warmIds: [] };
  for (const entries of sessions) {
    state = addNewUsage(state.total, entriesToMessages(entries), state.counted, state.turns ?? []);
    warm = addCacheWarmUsage(warm, entries);
  }
  const turns = state.turns ?? [];
  const by_origin: Record<TurnOrigin, number> = { automatico: 0, usuario: 0, indisponivel: 0 };
  for (const t of turns) by_origin[turnClass(t.trigger)]++;
  const total = state.total;
  return {
    sessions: sessions.length,
    turns: { ...summarizeTurns(turns), by_origin },
    tokens: {
      input: total.input,
      output: total.output,
      cacheRead: total.cacheRead,
      cacheWrite: total.cacheWrite,
      totalTokens: total.totalTokens,
    },
    cache: {
      hit_ratio: cacheHitRatio(total),
      denominator: total.input + total.cacheRead + total.cacheWrite,
    },
    cost_usd: total.cost,
    cost_from_provider: total.costFromProvider,
    cache_warm_cost_usd: warm.warm.cost,
  };
}
