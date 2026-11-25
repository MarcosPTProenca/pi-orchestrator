import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEW_SCHEMA_VERSION, parseReviewOutput, type ReviewResult } from "./review.ts";

const REVIEW_FILE = "review.json";
const SHA_RE = /^[0-9a-f]{40}$/;

export function recordReviewVerdict(
  taskDir: string,
  raw: string,
  headSha: string,
  diffTruncated: boolean,
): ReviewResult {
  if (!SHA_RE.test(headSha)) throw new Error("head_sha precisa ser um SHA completo de 40 hex minúsculos");
  const runId = `review-${Date.now().toString(36)}`;
  const result = parseReviewOutput(raw, { head_sha: headSha, truncated: diffTruncated }, runId);
  const file = join(taskDir, REVIEW_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, file);
  return result;
}

export function readReview(taskDir: string, headSha: string): ReviewResult | null {
  const file = join(taskDir, REVIEW_FILE);
  if (!existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as ReviewResult;
    if (r.schema_version !== REVIEW_SCHEMA_VERSION) return null;
    return r.reviewed_sha === headSha ? r : null;
  } catch {
    return null;
  }
}
