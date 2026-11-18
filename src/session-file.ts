import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Nome do ponteiro, na pasta da tarefa, com o caminho da sessão Pi do worker (gravado pela extensão do worker). */
export const SESSION_POINTER = "session.txt";

/** Caminho da sessão Pi do worker, só se o arquivo ainda existir em disco. */
export function workerSessionFile(taskDir: string): string | null {
  const pointer = join(taskDir, SESSION_POINTER);
  if (!existsSync(pointer)) return null;
  const file = readFileSync(pointer, "utf8").trim();
  return file && existsSync(file) ? file : null;
}
