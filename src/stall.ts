import { createHash } from "node:crypto";

export class StallWatch {
  private marks = new Map<string, { digest: string; since: number; announced: boolean }>();

  observe(taskId: string, output: string, now: number, afterMs: number): boolean {
    const digest = createHash("sha1").update(output.trimEnd()).digest("hex");
    const prev = this.marks.get(taskId);
    if (!prev || prev.digest !== digest) {
      this.marks.set(taskId, { digest, since: now, announced: false });
      return false;
    }
    if (prev.announced || now - prev.since < afterMs) return false;
    prev.announced = true;
    return true;
  }

  prune(runningIds: Set<string>): void {
    for (const id of this.marks.keys()) if (!runningIds.has(id)) this.marks.delete(id);
  }
}

export function stallNoticeFor(
  stalled: { task_id: string; project_id: string }[],
  afterMin: number,
  label: (projectId: string) => string,
): string {
  const items = stalled.map((s) => `${s.task_id} (${label(s.project_id)})`).join(", ");
  return `Workers em execução sem saída nova há ${afterMin} min: ${items}. Confira com orch_logs. Se estiver travado, decida: orch_send para destravar, ou orch_cancel e relançar. Se estiver só em processo longo, aguarde.`;
}
