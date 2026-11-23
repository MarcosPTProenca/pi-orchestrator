import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_POINTER = "session.txt";

export function workerSessionFile(taskDir: string): string | null {
  const pointer = join(taskDir, SESSION_POINTER);
  if (!existsSync(pointer)) return null;
  const file = readFileSync(pointer, "utf8").trim();
  return file && existsSync(file) ? file : null;
}
