import { execFile } from "node:child_process";

export const DEFAULT_PRIORITY = ["claude-bridge/claude-haiku-5-5", "openai-codex/gpt-6-luna", "kiro/auto"] as const;

export function quotaProviderOf(model: string): "claude" | "codex" | "kiro" | "other" {
  const provider = model.split("/")[0];
  if (provider === "claude-bridge" || provider === "anthropic") return "claude";
  if (provider === "openai-codex") return "codex";
  if (provider === "kiro") return "kiro";
  return "other";
}

export interface ProviderQuota {
  provider: string;
  percentRemaining: number | null;
  stale: boolean;
}

export function parseQuota(json: unknown): ProviderQuota[] {
  const providers = (json as { providers?: unknown[] })?.providers;
  if (!Array.isArray(providers)) throw new Error("resposta do quota-axi sem providers");
  return providers.map((p) => {
    const x = p as Record<string, unknown>;
    const eff = (
      (x.quotaSemantics as { effectiveAvailability?: { scope?: string; effectivePercentRemaining?: number }[] })
        ?.effectiveAvailability ?? []
    ).find((e) => e.scope === "all_models");
    const windows = (x.windows as { percentRemaining?: number }[]) ?? [];
    const fromWindows = windows.length ? Math.min(...windows.map((w) => w.percentRemaining ?? 100)) : null;
    const pct = typeof eff?.effectivePercentRemaining === "number" ? eff.effectivePercentRemaining : fromWindows;
    return {
      provider: String(x.provider),
      percentRemaining: pct,
      stale: Boolean((x.state as { stale?: boolean })?.stale),
    };
  });
}

export function readQuota(): Promise<ProviderQuota[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "quota-axi",
      ["--json", "--provider", "claude,codex", "--max-age", "5m"],
      { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`quota-axi falhou: ${(stderr || err.message).trim()}`));
          return;
        }
        try {
          resolve(parseQuota(JSON.parse(stdout)));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

export function pickModel(
  priority: readonly string[],
  quotas: ProviderQuota[],
  available: string[],
  minPercent = 10,
): { model: string; reason: string } {
  const byProvider = new Map(quotas.map((q) => [q.provider, q]));
  const skipped: string[] = [];
  for (const model of priority) {
    if (!available.includes(model)) {
      skipped.push(`${model} (indisponível)`);
      continue;
    }
    const kind = quotaProviderOf(model);
    if (kind === "kiro" || kind === "other") return { model, reason: `sem leitura de cota; último recurso` };
    const q = byProvider.get(kind);
    if (!q || q.percentRemaining === null) {
      skipped.push(`${model} (cota desconhecida)`);
      continue;
    }
    if (q.percentRemaining < minPercent) {
      skipped.push(`${model} (cota ${q.percentRemaining}%)`);
      continue;
    }
    return { model, reason: `cota ${kind} ${q.percentRemaining}% restante` };
  }
  throw new Error(`nenhum modelo com cota disponível. Pulados: ${skipped.join("; ") || "(nenhum)"}. Nada foi lançado.`);
}

export function checkRequestedQuota(model: string, quotas: ProviderQuota[], minPercent = 10): void {
  const kind = quotaProviderOf(model);
  if (kind === "kiro" || kind === "other") return;
  const q = quotas.find((x) => x.provider === kind);
  if (q && q.percentRemaining !== null && q.percentRemaining < minPercent) {
    throw new Error(
      `cota de ${kind} esgotada (${q.percentRemaining}% restante). "${model}" não foi lançado. Escolha outro modelo ou peça para usar a ordem automática.`,
    );
  }
}
