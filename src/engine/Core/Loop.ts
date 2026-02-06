export type FrameUpdate = (deltaMs: number, elapsedMs: number) => void;

export class GameLoop {
  private readonly onFrame: FrameUpdate;
  private readonly maxDeltaMs: number;
  private animationFrameId: number | null = null;
  private lastFrameTimeMs = 0;
  private elapsedMs = 0;
  private running = false;

  public constructor(onFrame: FrameUpdate, maxDeltaMs: number = 100) {
    this.onFrame = onFrame;
    this.maxDeltaMs = maxDeltaMs;
    this.tick = this.tick.bind(this);
  }

  public start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.lastFrameTimeMs = performance.now();
    this.animationFrameId = requestAnimationFrame(this.tick);
  }

  public stop(): void {
    this.running = false;

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  public reset(): void {
    this.elapsedMs = 0;
    this.lastFrameTimeMs = performance.now();
  }

  private tick(nowMs: number): void {
    if (!this.running) {
      return;
    }

    const rawDeltaMs = nowMs - this.lastFrameTimeMs;
    this.lastFrameTimeMs = nowMs;

    const deltaMs = Math.min(rawDeltaMs, this.maxDeltaMs);
    this.elapsedMs += deltaMs;

    this.onFrame(deltaMs, this.elapsedMs);
    this.animationFrameId = requestAnimationFrame(this.tick);
  }
}
