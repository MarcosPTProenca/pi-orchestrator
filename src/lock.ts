/**
 * Posse do diretório de estado: só uma sessão do orquestrador por vez escreve nele.
 * A segunda sessão viva fica em modo somente leitura (sem varredura, webhook, avisos ou lançamentos),
 * porque a varredura avisa qualquer tarefa do diretório e desviaria avisos da primeira.
 * Posse de processo morto (ou arquivo corrompido) é retomada. Limite conhecido: um pid reaproveitado
 * por outro processo parece vivo até o dono real soltar a posse ou o arquivo ser removido à mão.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface Owner {
  pid: number;
  started_at: string;
}

export interface Ownership {
  owner: boolean;
  holder?: Owner;
}

const FILE = "owner.json";

function readOwner(file: string): Owner | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Owner>;
    return typeof parsed.pid === "number" ? (parsed as Owner) : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: o processo existe, mas é de outro usuário.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireOwnership(dir: string): Ownership {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // "wx": falha se o arquivo já existe. É o que impede duas sessões de tomarem a posse ao mesmo tempo.
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      closeSync(fd);
      return { owner: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readOwner(file);
    if (holder?.pid === process.pid) return { owner: true };
    if (holder && alive(holder.pid)) return { owner: false, holder };
    // Dono morto ou arquivo corrompido: remove e tenta de novo.
    if (existsSync(file)) unlinkSync(file);
  }
  return { owner: false };
}

/** Solta a posse só se o arquivo ainda for nosso. Nunca apaga a posse de outro processo. */
export function releaseOwnership(dir: string): void {
  const file = join(dir, FILE);
  if (readOwner(file)?.pid === process.pid) unlinkSync(file);
}
