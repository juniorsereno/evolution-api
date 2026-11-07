export class CredentialPersistence {
  private dirty = false;
  private stopped = false;
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1000;

  constructor(
    private readonly save: () => Promise<void>,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  request(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running) this.running = this.persist().finally(() => (this.running = undefined));
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private async persist(): Promise<void> {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      try {
        await this.save();
        this.retryDelay = 1000;
      } catch (error) {
        this.dirty = true;
        this.onFailure(error);
        if (!this.stopped) {
          this.timer = setTimeout(() => void this.request(), this.retryDelay);
          this.timer.unref();
          this.retryDelay = Math.min(this.retryDelay * 2, 30000);
        }
        return;
      }
    }
  }
}
