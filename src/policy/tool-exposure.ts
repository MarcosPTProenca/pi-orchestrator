const TOOL_EXPOSURE_ENV = "PI_ORCH_TOOL_EXPOSURE";

export const DEFERRABLE_TOOLS: readonly string[] = ["orch_locate_project", "orch_logs", "orch_idle", "orch_plan_show"];

export function toolExposureFor(name: string, env: NodeJS.ProcessEnv = process.env): "direct" | "deferred" {
  return env[TOOL_EXPOSURE_ENV] === "hybrid" && DEFERRABLE_TOOLS.includes(name) ? "deferred" : "direct";
}

export function deferredToolsNote(env: NodeJS.ProcessEnv = process.env): string {
  const deferred = DEFERRABLE_TOOLS.filter((name) => toolExposureFor(name, env) === "deferred");
  if (deferred.length === 0) return "";
  return `Neste modo, ${deferred.join(", ")} não estão na lista de ferramentas diretas. Para usar uma delas, chame-a via codemode (\`tools.<nome>(args)\`) antes de concluir que não existe.`;
}
