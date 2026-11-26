/* keep: watchdog de inatividade do stream do modelo. O claude-bridge não tem timeout de inatividade; um stream parado prende o turno, e a contagem pausa durante ferramenta. */

export const STALL_IDLE_MS = 90_000;
export const STALL_MAX_RETRIES = 2;

export interface StallWatchdogOptions {
  idleMs: number;
  onStall: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class StallWatchdog {
  private handle: unknown = null;
  private armed = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: StallWatchdogOptions) {
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  start(): void {
    this.armed = true;
    this.reset();
  }

  progress(): void {
    if (this.armed) this.reset();
  }

  pause(): void {
    this.armed = false;
    this.clear();
  }

  private reset(): void {
    this.clear();
    this.handle = this.setTimer(() => {
      this.handle = null;
      this.armed = false;
      this.opts.onStall();
    }, this.opts.idleMs);
  }

  private clear(): void {
    if (this.handle === null) return;
    this.clearTimer(this.handle);
    this.handle = null;
  }
}
