import type { WatchEvent } from "./orchestrator.ts";

export interface Notification {
  title: string;
  body: string;
  sound: "request" | "done" | "none";
}

const MAX_BODY = 160;

export function notificationFor(e: Pick<WatchEvent, "status" | "project_id" | "question" | "result" | "error">): Notification | null {
  const clip = (text: string) => (text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text);
  switch (e.status) {
    case "blocked":
      return { title: `Decisão necessária: ${e.project_id}`, body: clip(e.question ?? "o worker aguarda uma resposta"), sound: "request" };
    case "done":
      return { title: `Concluída: ${e.project_id}`, body: clip(e.result ?? "tarefa concluída"), sound: "done" };
    case "failed":
      return { title: `Falhou: ${e.project_id}`, body: clip(e.error ?? "a tarefa não concluiu"), sound: "request" };
    default:
      return null;
  }
}

export function notifyEnabled(env: Record<string, string | undefined>): boolean {
  return env.PI_ORCH_NOTIFY !== "0";
}

export function notifyArgs(n: Notification): string[] {
  return ["notification", "show", n.title, "--body", n.body, "--sound", n.sound];
}
