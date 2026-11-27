import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEW_SCHEMA_VERSION, parseReviewOutput, type ReviewResult } from "./review.ts";

// keep: store fora do taskDir; limite aceito (VISION §1 e §3): mesmo usuário de SO, sem prova criptográfica; mitigado por ferramenta e gate de bash.
export interface PrRef {
  owner: string;
  name: string;
  number: number;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function reviewFile(stateDir: string, pr: PrRef, headSha: string): string {
  if (!SHA_RE.test(headSha)) throw new Error("head_sha precisa ser um SHA completo de 40 hex minúsculos");
  if (!SEGMENT_RE.test(pr.owner) || !SEGMENT_RE.test(pr.name) || !Number.isInteger(pr.number) || pr.number < 1)
    throw new Error("PR inválida para o store de review");
  return join(stateDir, "reviews", pr.owner, pr.name, `pr${pr.number}`, `${headSha}.json`);
}

export function recordReviewVerdict(
  stateDir: string,
  pr: PrRef,
  raw: string,
  headSha: string,
  diffTruncated: boolean,
): ReviewResult {
  const runId = `review-${Date.now().toString(36)}`;
  const result = parseReviewOutput(raw, { head_sha: headSha, truncated: diffTruncated }, runId);
  writeReviewResult(stateDir, pr, result);
  return result;
}

// keep: grava o resultado validado, inclusive unverified (que nunca aprova); só o hook pr-review chama.
export function writeReviewResult(stateDir: string, pr: PrRef, result: ReviewResult): void {
  const file = reviewFile(stateDir, pr, result.reviewed_sha);
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, file);
}

// keep: só devolve o veredito cujo head é exatamente o pedido; push novo invalida a aprovação anterior.
export function readReview(stateDir: string, pr: PrRef, headSha: string): ReviewResult | null {
  let file: string;
  try {
    file = reviewFile(stateDir, pr, headSha);
  } catch {
    return null;
  }
  if (!existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as ReviewResult;
    if (r.schema_version !== REVIEW_SCHEMA_VERSION) return null;
    return r.reviewed_sha === headSha ? r : null;
  } catch {
    return null;
  }
}
