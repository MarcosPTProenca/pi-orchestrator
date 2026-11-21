export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class NoticeBatcher<T extends { key: string }> {
  private items = new Map<string, T>();
  private timer: unknown;
  private attempts = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly send: (items: T[]) => void,
    private readonly sched: Scheduler = realScheduler,
    private readonly maxAttempts = 3,
    private readonly onGiveUp: (item: T) => void = () => undefined,
  ) {}

  push(item: T): void {
    if (this.items.has(item.key)) return;
    this.items.set(item.key, item);
    if (this.timer === undefined) this.arm();
  }

  flush(): void {
    this.timer = undefined;
    if (this.items.size === 0) return;
    const batch = [...this.items.values()];
    this.items.clear();
    try {
      this.send(batch);
      for (const i of batch) this.attempts.delete(i.key);
    } catch {
      for (const i of batch) {
        const n = (this.attempts.get(i.key) ?? 0) + 1;
        if (n < this.maxAttempts) {
          this.attempts.set(i.key, n);
          this.items.set(i.key, i);
        } else {
          this.attempts.delete(i.key);
          this.onGiveUp(i);
        }
      }
      if (this.items.size > 0 && this.timer === undefined) this.arm();
    }
  }

  drain(): T[] {
    if (this.timer !== undefined) this.sched.clear(this.timer);
    this.timer = undefined;
    const left = [...this.items.values()];
    this.items.clear();
    return left;
  }

  private arm(): void {
    this.timer = this.sched.set(() => this.flush(), this.windowMs);
  }
}
