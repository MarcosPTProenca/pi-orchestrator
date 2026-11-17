/**
 * Fila com concorrência fixa. Mecânica de lote: não depende de o modelo lembrar de respeitar 2 por vez.
 */
export class FixQueue<T> {
  private readonly concurrency: number;
  private readonly start: (item: T) => Promise<string>;
  private pending: T[] = [];
  private running = new Set<string>();
  readonly failed: { item: T; error: string; attempts: number }[] = [];
  private readonly maxAttempts: number;
  private readonly keyOf: (item: T) => string;
  private attempts = new Map<string, number>();

  constructor(concurrency: number, start: (item: T) => Promise<string>, opts: { maxAttempts?: number; keyOf?: (item: T) => string } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency deve ser inteiro >= 1");
    this.concurrency = concurrency;
    this.start = start;
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.keyOf = opts.keyOf ?? ((item) => JSON.stringify(item));
  }

  enqueue(items: T[]): Promise<void> {
    this.pending.push(...items);
    return this.pump();
  }

  /** Inicia itens até lotar a concorrência. Falha de início vai para `failed` e não trava a fila. */
  async pump(): Promise<void> {
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift() as T;
      const key = this.keyOf(item);
      const n = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, n);
      try {
        this.running.add(await this.start(item));
      } catch (err) {
        // Falha ao iniciar: tenta de novo até o limite antes de desistir e reportar.
        if (n < this.maxAttempts) this.pending.push(item);
        else this.failed.push({ item, error: err instanceof Error ? err.message : String(err), attempts: n });
      }
    }
  }

  /** Libera o slot de uma tarefa terminada e começa o próximo item. Tarefas fora da fila são ignoradas. */
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
