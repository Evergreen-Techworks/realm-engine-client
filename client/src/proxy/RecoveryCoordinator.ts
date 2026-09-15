let nextGeneration = 0;

interface RecoveryDeps {
  isConnected(): boolean;
  sendEscape(): void;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
}

export class RecoveryCoordinator {
  private generation = 0;
  private disposed = false;
  private latched = false;
  private operation = 0;
  private timer: unknown = null;

  constructor(private readonly deps: RecoveryDeps) {}

  beginGeneration(): number {
    this.stop();
    this.latched = false;
    this.generation = ++nextGeneration;
    return this.generation;
  }

  requestEscape(generation: number, options: { retries: number; retryMs: number }): boolean {
    if (this.disposed || generation !== this.generation || this.latched || !this.deps.isConnected()) return false;
    if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 10 || !Number.isFinite(options.retryMs) || options.retryMs <= 0) return false;
    this.latched = true;
    const operation = ++this.operation;
    let remaining = options.retries;
    const send = () => {
      if (this.disposed || generation !== this.generation || operation !== this.operation || !this.deps.isConnected()) return;
      this.timer = null;
      try { this.deps.sendEscape(); } catch {}
      if (this.disposed || generation !== this.generation || operation !== this.operation || !this.deps.isConnected() || remaining-- <= 0) return;
      this.timer = this.deps.schedule(send, options.retryMs);
    };
    send();
    return true;
  }

  cancelEscape(generation: number): void {
    if (generation !== this.generation) return;
    this.stop();
    this.latched = false;
  }

  acceptReconnect(generation: number): void {
    if (generation !== this.generation) return;
    this.stop();
    this.latched = true;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private stop(): void {
    this.operation++;
    if (this.timer !== null) this.deps.cancel(this.timer);
    this.timer = null;
  }
}
