/**
 * Serial, stoppable polling loop. One tick is allowed in flight per loop.
 * Stop interrupts idle sleep, then waits for the active tick to finish.
 */
export class WorkerLoop {
  private readonly controller = new AbortController();
  private task?: Promise<void>;
  private stopped = false;
  private ticks = 0;
  private errors = 0;

  constructor(
    public readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {
    if (!name.trim() || !Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error('WorkerLoop requires a name and a positive integer intervalMs');
    }
  }

  get stats(): Readonly<{ ticks: number; errors: number; running: boolean }> {
    return { ticks: this.ticks, errors: this.errors, running: !!this.task && !this.stopped };
  }

  start(): void {
    if (this.stopped) throw new Error(`Cannot restart stopped worker: ${this.name}`);
    if (this.task) return; // idempotent Nest lifecycle initialization
    this.task = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    await this.task;
  }

  private async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      try {
        await this.tick();
        this.ticks++;
      } catch (error) {
        this.errors++;
        // Error reporting must not kill the worker loop either.
        try { this.onError(error); } catch { /* continue polling */ }
      }
      if (this.controller.signal.aborted) break;
      await interruptibleSleep(this.intervalMs, this.controller.signal);
    }
  }
}

/** Resolves immediately when SIGTERM/stop is requested. Never rejects. */
export function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let completed = false;
    const done = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
