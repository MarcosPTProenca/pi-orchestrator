import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prFromUrl } from "../shared/prs.ts";

type Verdict = "approved" | "rejected" | "not_applicable" | "unverified";
export interface Verification {
  verdict: Verdict;
  reason: string;
}

export interface VerifyEnv {
  prCheck(url: string): Promise<{ ok: boolean; line: string }>;
  commitExists(sha: string): boolean;
  pathExists(path: string): boolean;
  taskDir?: string;
}

const SHA_RE = /\b[0-9a-f]{7,40}\b/g;

interface EvidenceCommand {
  command?: unknown;
  exit_code?: unknown;
}

function verifyExecutionEvidence(taskDir: string | undefined): string[] {
  if (!taskDir) return [];
  const ticketPath = join(taskDir, "ticket.json");
  const evidencePath = join(taskDir, "execution-evidence.json");
  if (!existsSync(ticketPath)) return [];
  if (!existsSync(evidencePath)) return ["execution-evidence.json ausente na pasta real da tarefa"];

  try {
    const ticket = JSON.parse(readFileSync(ticketPath, "utf8")) as {
      task_id?: unknown;
      attempt_id?: unknown;
      validation?: { commands?: unknown };
    };
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
      schema_version?: unknown;
      task_id?: unknown;
      attempt_id?: unknown;
      complete?: unknown;
      commands?: unknown;
      tdd?: { applicable?: unknown; seams?: unknown };
    };
    const problems: string[] = [];
    if (evidence.schema_version !== 1) problems.push("schema de execution-evidence.json inválido");
    if (evidence.task_id !== ticket.task_id || evidence.attempt_id !== ticket.attempt_id)
      problems.push("execution-evidence.json pertence a outra tarefa ou tentativa");
    if (evidence.complete !== true) problems.push("execution-evidence.json incompleto");
    const commands = Array.isArray(evidence.commands) ? (evidence.commands as EvidenceCommand[]) : [];
    const expected = Array.isArray(ticket.validation?.commands) ? ticket.validation.commands : [];
    for (const required of expected) {
      const found = commands.some((entry) => entry.command === required && entry.exit_code === 0);
      if (!found) problems.push(`validação prescrita não executada com sucesso: ${String(required)}`);
    }

    const planPath = join(taskDir, "implementation-plan.json");
    const plan = existsSync(planPath)
      ? (JSON.parse(readFileSync(planPath, "utf8")) as { test_seams?: { name?: unknown }[] })
      : null;
    const seams = (plan?.test_seams ?? [])
      .map((seam) => seam.name)
      .filter((name): name is string => typeof name === "string");
    const tddSeams = Array.isArray(evidence.tdd?.seams) ? evidence.tdd.seams : [];
    for (const seam of seams) {
      const record = tddSeams.find((item) => (item as { seam?: unknown })?.seam === seam) as
        | {
            red?: { command_index?: unknown; exit_code?: unknown };
            green?: { command_index?: unknown; exit_code?: unknown };
          }
        | undefined;
      const red = record?.red;
      const green = record?.green;
      const redIndex = red?.command_index;
      const greenIndex = green?.command_index;
      const redExit = red?.exit_code;
      const greenExit = green?.exit_code;
      if (
        typeof redIndex !== "number" ||
        !Number.isInteger(redIndex) ||
        typeof greenIndex !== "number" ||
        !Number.isInteger(greenIndex) ||
        redIndex < 0 ||
        greenIndex < 0 ||
        redIndex >= greenIndex ||
        greenIndex >= commands.length ||
        typeof redExit !== "number" ||
        redExit === 0 ||
        greenExit !== 0 ||
        commands[redIndex]?.exit_code !== redExit ||
        commands[greenIndex]?.exit_code !== greenExit
      )
        problems.push(`TDD red→green ausente ou inválido para test seam ${seam}`);
    }
    return problems;
  } catch (err) {
    return [`execution-evidence.json inválido: ${err instanceof Error ? err.message : String(err)}`];
  }
}

export async function judgeDone(
  mode: string,
  status: string,
  artifacts: string[],
  env: VerifyEnv,
): Promise<Verification> {
  if (status !== "done") return { verdict: "not_applicable", reason: "tarefa não concluída pelo worker" };
  try {
    if (mode === "direct-pr") {
      const prs = artifacts.map(prFromUrl).filter((p): p is NonNullable<typeof p> => p !== null);
      if (prs.length === 0) return { verdict: "rejected", reason: "modo direct-pr sem PR em artefatos" };
      const evidenceProblems = verifyExecutionEvidence(env.taskDir);
      if (evidenceProblems.length > 0)
        return { verdict: "rejected", reason: `evidência de execução rejeitada: ${evidenceProblems.join("; ")}` };
      const lines: string[] = [];
      let rejected = false;
      for (const url of artifacts.filter((a) => prFromUrl(a))) {
        const r = await env.prCheck(url);
        lines.push(r.line);
        if (!r.ok) rejected = true;
      }
      return { verdict: rejected ? "rejected" : "approved", reason: lines.join(" ") };
    }
    if (mode === "local-only") {
      const shas = artifacts.flatMap((a) => a.match(SHA_RE) ?? []);
      if (shas.length === 0)
        return { verdict: "rejected", reason: "modo local-only sem commit informado em artefatos" };
      const found = shas.filter((s) => env.commitExists(s));
      if (found.length === 0)
        return { verdict: "rejected", reason: `nenhum commit encontrado no repositório entre: ${shas.join(", ")}` };
      return { verdict: "approved", reason: `commit(s) presentes no repositório: ${found.join(", ")}` };
    }
    if (mode === "report") {
      const files = artifacts.filter((a) => a.startsWith("/"));
      if (files.length === 0) return { verdict: "not_applicable", reason: "sem arquivo de artefato para conferir" };
      const gone = files.filter((f) => !env.pathExists(f));
      if (gone.length > 0) return { verdict: "rejected", reason: `artefato inexistente: ${gone.join(", ")}` };
      return { verdict: "approved", reason: "artefatos existem" };
    }
    return { verdict: "not_applicable", reason: `modo ${mode} sem verificação determinística` };
  } catch (err) {
    return { verdict: "unverified", reason: `não consegui conferir (${String(err).slice(0, 160)})` };
  }
}
