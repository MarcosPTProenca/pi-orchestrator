import assert from "node:assert/strict";
import workerExtension from "../src/worker/worker-ext.ts";

export type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;
export type Tool = {
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

// keep: carrega a extensão do worker com handlers e ferramentas em memória, sem Pi real.
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

const WORKER_ENV = ["PI_ORCH_ROLE", "PI_ORCH_TASK_ID", "PI_ORCH_TASK_DIR", "PI_ORCH_TOOL_POLICY"] as const;

export interface WorkerSession {
  tools: Record<string, Tool>;
  startTurn: () => Promise<void>;
  endTurn: () => Promise<void>;
}

// keep: o ambiente do worker vale só dentro de run e é restaurado mesmo se o teste falhar.
export async function asWorker<T>(
  task: { task_id: string; task_dir: string },
  run: (w: WorkerSession) => Promise<T>,
): Promise<T> {
  const prev = WORKER_ENV.map((k) => [k, process.env[k]] as const);
  try {
    delete process.env.PI_ORCH_TOOL_POLICY;
    process.env.PI_ORCH_ROLE = "worker";
    process.env.PI_ORCH_TASK_ID = task.task_id;
    process.env.PI_ORCH_TASK_DIR = task.task_dir;
    const { handlers, tools } = loadWorker();
    const ctx = { sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined } };
    return await run({
      tools,
      startTurn: async () => {
        await handlers.agent_start({}, ctx);
      },
      endTurn: async () => {
        await handlers.agent_end({ messages: [] }, ctx);
        await handlers.agent_settled({}, ctx);
      },
    });
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// keep: último turno do worker: relatório done, fim do turno, refresh e checagem de que a tarefa virou done.
export async function reportDone(
  w: Pick<WorkerSession, "tools" | "startTurn" | "endTurn">,
  orch: {
    refresh: (taskId: string) => Promise<unknown>;
    get: (taskId: string) => { status: string; result: string | null };
  },
  taskId: string,
  result: string,
): Promise<void> {
  await w.startTurn();
  await w.tools.orch_report.execute("c2", { status: "done", result });
  await w.endTurn();
  await orch.refresh(taskId);
  assert.equal(orch.get(taskId).status, "done");
  assert.equal(orch.get(taskId).result, result);
}
