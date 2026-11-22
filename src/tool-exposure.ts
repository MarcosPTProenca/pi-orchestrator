// Exposição das tools orch_* (#103). Opt-in por PI_ORCH_TOOL_EXPOSURE=hybrid: só consultas
// somente-leitura saem da declaração direta e ficam acessíveis via codemode. Efeitos
// colaterais, autorização e dono continuam no execute de cada tool, independentemente do canal.
const TOOL_EXPOSURE_ENV = "PI_ORCH_TOOL_EXPOSURE";

export const DEFERRABLE_TOOLS: readonly string[] = ["orch_locate_project", "orch_logs", "orch_idle", "orch_plan_show"];

export function toolExposureFor(name: string, env: NodeJS.ProcessEnv = process.env): "direct" | "deferred" {
  return env[TOOL_EXPOSURE_ENV] === "hybrid" && DEFERRABLE_TOOLS.includes(name) ? "deferred" : "direct";
}
