/**
 * Fila com concorrência fixa. Mecânica de lote: não depende de o modelo lembrar de respeitar 2 por vez.
 */
export class FixQueue<T> {
  private concurrency: number;
  private readonly onFailed: (f: { item: T; error: string; attempts: number }) => void;
  /** Só inicia quando há vaga global (teto de workers). Sem isso, a fila respeita só o próprio limite. */
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
    opts: { maxAttempts?: number; keyOf?: (item: T) => string; onFailed?: (f: { item: T; error: string; attempts: number }) => void; canStart?: () => boolean } = {},
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

  /** Inicia itens até lotar a concorrência. Falha de início vai para `failed` e não trava a fila. */
  async pump(): Promise<void> {
    while (this.running.size < this.concurrency && this.pending.length > 0 && this.canStart()) {
      const item = this.pending.shift() as T;
      const key = this.keyOf(item);
      const n = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, n);
      try {
        this.running.add(await this.start(item));
      } catch (err) {
        // Falha ao iniciar: tenta de novo até o limite antes de desistir e reportar.
        if (n < this.maxAttempts) this.pending.push(item);
        else {
          const f = { item, error: err instanceof Error ? err.message : String(err), attempts: n };
          this.failed.push(f);
          // Falha definitiva vai para quem mantém a fila agora, não só para a resposta da chamada original.
          this.onFailed(f);
        }
      }
    }
  }

  get failedCount(): number {
    return this.failed.length;
  }

  /** Falhas definitivas ocorridas depois de uma contagem anterior (failedCount). */
  failedSince(mark: number): { item: T; error: string; attempts: number }[] {
    return this.failed.slice(mark);
  }

  /** Muda o limite de paralelismo (1 a 4). Aumentar começa os pendentes; reduzir não cancela os em execução. */
  async setConcurrency(n: number): Promise<void> {
    if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error("concurrency deve estar entre 1 a 4");
    this.concurrency = n;
    await this.pump();
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
