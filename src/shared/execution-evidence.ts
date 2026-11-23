import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PublishState } from "./publish.ts";

export const EVIDENCE_FILE = "execution-evidence.json";
const LOG_FILE = "evidence-log.json";
const SCHEMA_VERSION = 1;
const TDD_KINDS = ["bug", "feature"];

export interface CommandRecord {
  command: string;
  exit_code: number | null;
  at: string;
  excerpt: string;
}

export interface TddMark {
  seam: string;
  phase: "red" | "green";
  command_index: number;
}

export interface EvidenceLog {
  commands: CommandRecord[];
  marks: TddMark[];
}

export interface TddRecord {
  seam: string;
  red: { command_index: number; command: string; exit_code: number | null };
  green: { command_index: number; command: string; exit_code: number | null };
}

export interface EvidenceInput {
  task_id: string;
  attempt_id: string;
  kind: string | null;
  versions: { node: string; pi: string | null; implement_skill_sha256: string | null };
  skill_loaded: boolean;
  publish: PublishState | null;
  log: EvidenceLog;
  seams: string[];
  steps: string[];
  deviations: string[];
  base_sha: string | null;
  head_sha: string | null;
}

export interface Evidence {
  schema_version: number;
  task_id: string;
  attempt_id: string;
  versions: EvidenceInput["versions"];
  skill: { name: "implement"; loaded: boolean };
  base_sha: string | null;
  head_sha: string | null;
  publish: { branch: string | null; pushed_sha: string | null; pr_url: string | null } | null;
  steps: string[];
  tdd: { applicable: boolean; seams: TddRecord[] };
  commands: CommandRecord[];
  deviations: string[];
  complete: boolean;
  missing: string[];
}

function pairFor(seam: string, log: EvidenceLog, problems: string[]): TddRecord | null {
  const red = log.marks.find((m) => m.seam === seam && m.phase === "red");
  const green = log.marks.find((m) => m.seam === seam && m.phase === "green");
  if (!red) problems.push(`${seam}: sem red marcado`);
  if (!green) problems.push(`${seam}: sem green marcado`);
  if (!red || !green) return null;
  const r = log.commands[red.command_index];
  const g = log.commands[green.command_index];
  if (!r || !g) {
    problems.push(`${seam}: marca aponta comando inexistente`);
    return null;
  }
  if (r.exit_code === null) problems.push(`${seam}: red sem exit code conhecido`);
  else if (r.exit_code === 0) problems.push(`${seam}: red não falhou (exit 0)`);
  if (g.exit_code === null) problems.push(`${seam}: green sem exit code conhecido`);
  else if (g.exit_code !== 0) problems.push(`${seam}: green não passou (exit ${g.exit_code})`);
  if (green.command_index <= red.command_index) problems.push(`${seam}: green antes de red`);
  const ok = !problems.some((p) => p.startsWith(`${seam}:`));
  if (!ok) return null;
  return {
    seam,
    red: { command_index: red.command_index, command: r.command, exit_code: r.exit_code },
    green: { command_index: green.command_index, command: g.command, exit_code: g.exit_code },
  };
}

export function tddCheck(log: EvidenceLog, seams: string[]): { seams: TddRecord[]; problems: string[] } {
  const problems: string[] = [];
  const records: TddRecord[] = [];
  for (const seam of seams) {
    const rec = pairFor(seam, log, problems);
    if (rec) records.push(rec);
  }
  return { seams: records, problems };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      const text = (part as { text?: unknown } | null)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

export function skillLoaded(entries: unknown[], name: string): boolean {
  const marker = `<skill name="${name}" location="`;
  return entries.some((e) => {
    const entry = e as { type?: string; message?: { role?: string; content?: unknown } };
    return entry.type === "message" && entry.message?.role === "user" && textOf(entry.message.content).includes(marker);
  });
}

export function buildEvidence(input: EvidenceInput): Evidence {
  const tdd = tddCheck(input.log, input.seams);
  const missing: string[] = [];
  if (!input.skill_loaded) missing.push("skill implement não carregada na sessão");
  if (input.seams.length === 0 && TDD_KINDS.includes(input.kind ?? ""))
    missing.push("sem test seams para TDD em bug/feature");
  missing.push(...tdd.problems);
  return {
    schema_version: SCHEMA_VERSION,
    task_id: input.task_id,
    attempt_id: input.attempt_id,
    versions: input.versions,
    skill: { name: "implement", loaded: input.skill_loaded },
    base_sha: input.base_sha,
    head_sha: input.head_sha,
    publish: input.publish
      ? { branch: input.publish.branch, pushed_sha: input.publish.pushed_sha, pr_url: input.publish.pr_url }
      : null,
    steps: input.steps,
    tdd: { applicable: input.seams.length > 0, seams: tdd.seams },
    commands: input.log.commands,
    deviations: input.deviations,
    complete: missing.length === 0,
    missing,
  };
}

function writeAtomic(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

export function readEvidenceLog(taskDir: string): EvidenceLog {
  const file = join(taskDir, LOG_FILE);
  if (!existsSync(file)) return { commands: [], marks: [] };
  return JSON.parse(readFileSync(file, "utf8")) as EvidenceLog;
}

export function appendCommand(taskDir: string, record: CommandRecord): void {
  const log = readEvidenceLog(taskDir);
  log.commands.push(record);
  writeAtomic(join(taskDir, LOG_FILE), JSON.stringify(log, null, 2));
}

export function appendMark(taskDir: string, mark: TddMark): void {
  const log = readEvidenceLog(taskDir);
  log.marks.push(mark);
  writeAtomic(join(taskDir, LOG_FILE), JSON.stringify(log, null, 2));
}

export function writeEvidence(taskDir: string, evidence: Evidence): void {
  writeAtomic(join(taskDir, EVIDENCE_FILE), JSON.stringify(evidence, null, 2));
}
