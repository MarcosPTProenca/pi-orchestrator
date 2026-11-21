import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

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
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function scopeKey(cwd: string): string {
  let root = cwd;
  try {
    root =
      execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || cwd;
  } catch {}
  let real = root;
  try {
    real = realpathSync(root);
  } catch {}
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

export function scopeOwnerDir(stateDir: string, key: string): string {
  return join(stateDir, "owners", key);
}

export function hasLiveOwner(dir: string): boolean {
  const holder = readOwner(join(dir, FILE));
  return holder !== null && alive(holder.pid);
}

function within(child: string, parent: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const c = real(child);
  const p = real(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

export function legacyAdopter(scope: { key: string; cwd: string; stateDir: string }): (projectPath: string) => boolean {
  return (projectPath) => {
    const key = scopeKey(projectPath);
    if (key === scope.key) return true;
    const sameRepo = repoIdentity(projectPath) !== undefined && repoIdentity(projectPath) === repoIdentity(scope.cwd);
    return (sameRepo || within(projectPath, scope.cwd)) && !hasLiveOwner(scopeOwnerDir(scope.stateDir, key));
  };
}

export function acquireOwnership(dir: string): Ownership {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
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
    if (existsSync(file)) unlinkSync(file);
  }
  return { owner: false };
}

export function releaseOwnership(dir: string): void {
  const file = join(dir, FILE);
  if (readOwner(file)?.pid === process.pid) unlinkSync(file);
}

const keyCache = new Map<string, string>();

function keyOf(path: string): string {
  let key = keyCache.get(path);
  if (key === undefined) {
    key = scopeKey(path);
    keyCache.set(path, key);
  }
  return key;
}

export function ownsByRepo(taskProject: string, sessionKey: string, sessionCwd: string): boolean {
  if (keyOf(taskProject) === sessionKey) return true;
  const identity = repoIdentity(taskProject);
  if (identity !== undefined && identity === repoIdentity(sessionCwd)) return true;
  return within(taskProject, sessionCwd) && keyOf(sessionCwd) === sessionKey && !isRepoRoot(sessionCwd);
}

function isRepoRoot(cwd: string): boolean {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

const identityCache = new Map<string, string | undefined>();

export function repoIdentity(path: string): string | undefined {
  if (identityCache.has(path)) return identityCache.get(path);
  let id: string | undefined;
  try {
    const out = execFileSync("git", ["-C", path, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    id = realpathSync(resolve(path, out));
  } catch {
    id = undefined;
  }
  identityCache.set(path, id);
  return id;
}
