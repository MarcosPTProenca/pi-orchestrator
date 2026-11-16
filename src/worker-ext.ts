/**
 * Extensão do worker. Carregada só quando PI_ORCH_ROLE=worker (definido pelo
 * orquestrador ao criar o pane). Registra a tool `orch_report`, que grava
 * `report.json` na pasta da tarefa. Não altera o restante do setup do Pi.
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REPORT_STATUSES, validateReport } from "./contract.ts";

export default function workerExtension(pi: ExtensionAPI): void {
  if (process.env.PI_ORCH_ROLE !== "worker") return;
  const taskId = process.env.PI_ORCH_TASK_ID;
  const taskDir = process.env.PI_ORCH_TASK_DIR;
  if (!taskId || !taskDir) return;

  pi.registerTool({
    name: "orch_report",
    label: "orch report",
    description:
      "Registra o relatório final desta tarefa para o orquestrador. Chame uma vez no fim. Use status blocked com question quando precisar de decisão humana.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...REPORT_STATUSES] },
        result: { type: "string" },
        question: { type: "string" },
        artifacts: { type: "array", items: { type: "string" } },
      },
      required: ["status", "result"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const report = validateReport(
        { ...params, task_id: taskId, reported_at: new Date().toISOString() },
        taskId,
      );
      const file = join(taskDir, "report.json");
      writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2));
      renameSync(`${file}.tmp`, file);
      return {
        content: [{ type: "text" as const, text: `Relatório registrado (${report.status}).` }],
        details: report,
      };
    },
  });
}
