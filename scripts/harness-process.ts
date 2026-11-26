import { spawn } from "node:child_process";

export interface ProcessGroupResult {
  code: number;
  timedOut: boolean;
  stderr: string;
}

// keep: no prazo ou ao fechar, mata o grupo inteiro; matar só o pi deixa o claude filho órfão.
export function runProcessGroup(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<ProcessGroupResult> {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.resume();
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // keep: grupo já sem membros, nada a matar.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeout);
    child.on("error", (err) => {
      clearTimeout(timer);
      killGroup();
      resolveRun({ code: -1, timedOut, stderr: stderr || String(err) });
    });
    // keep: exit, não close; close espera todos os pipes, e um neto órfão segura o stdout.
    child.on("exit", (code) => {
      clearTimeout(timer);
      killGroup();
      resolveRun({ code: code ?? -1, timedOut, stderr });
    });
  });
}
