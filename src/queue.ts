export class FixQueue<T> {
  private concurrency: number;
  private readonly onFailed: (f: { item: T; error: string; attempts: number }) => void;
  private readonly canStart: () => boolean;
  private readonly start: (item: T) => Promise<string>;
  private pending: T[] = [];
  private running = new Set<string>();
  readonly failed: { item: T; error: string; attempts: number }[] = [];
  private readonly maxAttempts: number;
  private readonly keyOf: (item: T) => string;
  private attempts = new Map<string, number>();

  constructor(
    concurrency: number,
    start: (item: T) => Promise<string>,
    opts: {
      maxAttempts?: number;
      keyOf?: (item: T) => string;
      onFailed?: (f: { item: T; error: string; attempts: number }) => void;
      canStart?: () => boolean;
    } = {},
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency deve ser inteiro >= 1");
    this.concurrency = concurrency;
    this.start = start;
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.keyOf = opts.keyOf ?? ((item) => JSON.stringify(item));
    this.onFailed = opts.onFailed ?? (() => undefined);
    this.canStart = opts.canStart ?? (() => true);
  }

  enqueue(items: T[]): Promise<void> {
    this.pending.push(...items);
    return this.pump();
  }

  async pump(): Promise<void> {
    while (this.running.size < this.concurrency && this.pending.length > 0 && this.canStart()) {
      const item = this.pending.shift() as T;
      const key = this.keyOf(item);
      const n = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, n);
      try {
        this.running.add(await this.start(item));
      } catch (err) {
        if (n < this.maxAttempts) this.pending.push(item);
        else {
          const f = { item, error: err instanceof Error ? err.message : String(err), attempts: n };
          this.failed.push(f);
          this.onFailed(f);
        }
      }
    }
  }

  get failedCount(): number {
    return this.failed.length;
  }

  failedSince(mark: number): { item: T; error: string; attempts: number }[] {
    return this.failed.slice(mark);
  }

  async setConcurrency(n: number): Promise<void> {
    if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error("concurrency deve estar entre 1 a 4");
    this.concurrency = n;
    await this.pump();
  }

  async settle(taskId: string): Promise<void> {
    if (this.running.delete(taskId)) await this.pump();
  }

  get runningIds(): string[] {
    return [...this.running];
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
