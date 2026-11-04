// Per-job timing and token usage, so we know where the seconds and the cost go.

export type Span = { name: string; start: number; ms: number };

export class Trace {
  t0 = performance.now();
  spans: Span[] = [];
  usage: { name: string; usage: unknown }[] = [];

  // Time a promise-returning step. Spans may overlap (parallel steps).
  async time<T>(name: string, f: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await f();
    } finally {
      this.spans.push({ name, start: Math.round(start - this.t0), ms: Math.round(performance.now() - start) });
    }
  }

  addUsage(name: string, usage: unknown) {
    if (usage) this.usage.push({ name, usage });
  }

  summary() {
    const spans = [...this.spans].sort((a, b) => a.start - b.start).map((s) => `${s.name} ${s.start}+${s.ms}`);
    return `${spans.join(', ')} | usage ${JSON.stringify(this.usage)}`;
  }
}
