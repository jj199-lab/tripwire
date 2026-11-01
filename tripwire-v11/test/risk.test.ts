import { describe, expect, it } from "vitest";
import {
  CCR,
  DEFAULT_TIERS,
  MAX_ICR,
  MCR,
  WAD,
  computeIcr,
  dropToLiquidationBps,
  liquidationPrice,
  nextTier,
  rawTier,
  redemptionPercentile,
} from "../src/risk.js";

const btc = (n: number) => BigInt(Math.round(n * 1e8)) * 10n ** 10n; // 18-decimal
const usd = (n: number) => BigInt(n) * WAD;

describe("ICR and liquidation math", () => {
  // 1 BTC at $100,000 backing 50,000 MUSD
  const coll = btc(1);
  const price = usd(100_000);
  const debt = usd(50_000);

  it("computes ICR as 200%", () => {
    expect(computeIcr(coll, price, debt)).toBe(2n * WAD);
  });

  it("liquidation price is MCR * debt / coll = $55,000", () => {
    expect(liquidationPrice(coll, debt)).toBe(usd(55_000));
  });

  it("drop to liquidation is 45%", () => {
    expect(dropToLiquidationBps(price, liquidationPrice(coll, debt))).toBe(4500);
  });

  it("matches the spec example: max borrow at MCR gives ICR 110%", () => {
    // 1 BTC at $100,000 borrowing 90,909.09... MUSD sits at about 110%
    const maxDebt = (coll * price) / MCR;
    expect(computeIcr(coll, price, maxDebt)).toBeGreaterThanOrEqual(MCR);
  });

  it("zero debt returns the max ICR and no liquidation price", () => {
    expect(computeIcr(coll, price, 0n)).toBe(MAX_ICR);
    expect(liquidationPrice(coll, 0n)).toBe(0n);
  });

  it("already below liquidation price gives 0 drop", () => {
    expect(dropToLiquidationBps(usd(50_000), usd(55_000))).toBe(0);
  });
});

describe("tiers", () => {
  const pctWad = (p: number) => (BigInt(Math.round(p * 100)) * WAD) / 10_000n;

  it("classifies by bounds", () => {
    expect(rawTier(pctWad(200))).toBe("safe");
    expect(rawTier(pctWad(149))).toBe("watch");
    expect(rawTier(pctWad(134))).toBe("warning");
    expect(rawTier(pctWad(119))).toBe("urgent");
    expect(rawTier(pctWad(109))).toBe("liquidatable");
    expect(rawTier(CCR)).toBe("safe");
    expect(rawTier(MCR)).toBe("urgent");
  });

  it("escalates immediately", () => {
    expect(nextTier("safe", pctWad(118))).toBe("urgent");
    expect(nextTier(undefined, pctWad(140))).toBe("watch");
  });

  it("does not step down until ICR clears bound plus hysteresis", () => {
    // In urgent (bound 120%). 121% is above the bound but inside the 3pt buffer.
    expect(nextTier("urgent", pctWad(121))).toBe("urgent");
    expect(nextTier("urgent", pctWad(122.9))).toBe("urgent");
    expect(nextTier("urgent", pctWad(123))).toBe("warning");
  });

  it("can step down more than one tier once clear", () => {
    expect(nextTier("urgent", pctWad(200))).toBe("safe");
  });

  it("hysteresis default is 3 points", () => {
    expect(DEFAULT_TIERS.hysteresis).toBe((3n * WAD) / 100n);
  });
});

describe("redemption percentile", () => {
  it("front of queue is 0 and back is 1", () => {
    expect(redemptionPercentile(1, 100)).toBe(0);
    expect(redemptionPercentile(100, 100)).toBe(1);
  });
  it("single trove list is 0", () => {
    expect(redemptionPercentile(1, 1)).toBe(0);
  });
});
