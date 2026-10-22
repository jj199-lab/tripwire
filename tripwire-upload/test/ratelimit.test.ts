import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/ratelimit.js";

describe("RateLimiter", () => {
  it("allows up to max, warns once, then drops, per key", () => {
    let t = 0;
    const r = new RateLimiter(2, 1000, () => t);
    expect([r.check(1), r.check(1), r.check(1), r.check(1), r.check(1)]).toEqual(["ok", "ok", "warn", "drop", "drop"]);
    expect(r.check(2)).toBe("ok");
  });

  it("starts a fresh window after windowMs", () => {
    let t = 0;
    const r = new RateLimiter(1, 1000, () => t);
    expect([r.check(1), r.check(1)]).toEqual(["ok", "warn"]);
    t = 1000;
    expect(r.check(1)).toBe("ok");
    expect(r.check(1)).toBe("warn");
  });

  it("does not grow without bound", () => {
    let t = 0;
    const r = new RateLimiter(5, 1000, () => t);
    for (let i = 0; i < 6000; i++) r.check(i);
    t = 5000;
    r.check(99999); // triggers a prune of stale windows
    expect((r as unknown as { hits: Map<number, unknown> }).hits.size).toBe(1);
  });
});
