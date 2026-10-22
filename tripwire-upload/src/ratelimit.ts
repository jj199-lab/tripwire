/**
 * Best-effort per-chat limiter: at most `max` messages per fixed window.
 * Lives in memory, so on a hosted Worker each isolate keeps its own counts. That is enough to blunt
 * spam without spending any database writes.
 */
export type Verdict = "ok" | "warn" | "drop";

export class RateLimiter {
  private hits = new Map<number, { start: number; count: number; warned: boolean }>();

  constructor(
    private max = 12,
    private windowMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  /** "ok": allowed. "warn": first message over the limit (send one polite reply). "drop": ignore silently. */
  check(key: number): Verdict {
    const t = this.now();
    if (this.hits.size > 5000) this.prune(t);
    let h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      h = { start: t, count: 0, warned: false };
      this.hits.set(key, h);
    }
    h.count++;
    if (h.count <= this.max) return "ok";
    if (!h.warned) {
      h.warned = true;
      return "warn";
    }
    return "drop";
  }

  private prune(t: number): void {
    for (const [k, h] of this.hits) if (t - h.start >= this.windowMs) this.hits.delete(k);
  }
}
