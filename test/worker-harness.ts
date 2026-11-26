import workerExtension from "../src/worker/worker-ext.ts";

export type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;
export type Tool = {
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

// Carrega a extensão do worker com handlers e ferramentas registrados em memória, sem Pi real.
export function loadWorker(): { handlers: Record<string, Handler>; tools: Record<string, Tool> } {
  const handlers: Record<string, Handler> = {};
  const tools: Record<string, Tool> = {};
  workerExtension({
    on: (name: string, fn: Handler) => {
      handlers[name] = fn;
    },
    registerTool: (t: { name: string } & Tool) => {
      tools[t.name] = t;
    },
    registerEntryRenderer: () => {},
    appendEntry: () => {},
  } as never);
  return { handlers, tools };
}
