/** Rolling frame-time statistics over the last few seconds. */
export class FrameStats {
  private times = new Float64Array(240);
  private count = 0;
  private index = 0;
  private last = 0;

  push(now: number): void {
    if (this.last > 0) {
      this.times[this.index] = now - this.last;
      this.index = (this.index + 1) % this.times.length;
      this.count = Math.min(this.count + 1, this.times.length);
    }
    this.last = now;
  }

  reset(): void {
    this.count = 0;
    this.index = 0;
    this.last = 0;
  }

  summary(): { fps: number; avgMs: number; p99Ms: number; worstMs: number; samples: number } {
    if (this.count === 0) return { fps: 0, avgMs: 0, p99Ms: 0, worstMs: 0, samples: 0 };
    const sorted = Array.from(this.times.subarray(0, this.count)).sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return {
      fps: +(1000 / avg).toFixed(1),
      avgMs: +avg.toFixed(2),
      p99Ms: +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))].toFixed(2),
      worstMs: +sorted[sorted.length - 1].toFixed(2),
      samples: sorted.length,
    };
  }
}
