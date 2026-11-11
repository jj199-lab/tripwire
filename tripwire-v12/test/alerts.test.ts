import { describe, expect, it } from "vitest";
import { decide, inRedemptionZone, REDEMPTION_ENTER_RANK, REDEMPTION_EXIT_RANK } from "../src/alerts.js";
import { withPriceDrop } from "../src/demo.js";
import type { PositionSnapshot, RankResult } from "../src/reader.js";
import { WAD, computeIcr, dropToLiquidationBps, liquidationPrice, rawTier } from "../src/risk.js";

const price = 80_000n * WAD;
const coll = WAD; // 1 BTC

function snapAt(icrPct: number): PositionSnapshot {
  const debt = (coll * price * 100n) / (BigInt(Math.round(icrPct * 100)) * WAD) * 100n;
  const icr = computeIcr(coll, price, debt);
  const liq = liquidationPrice(coll, debt);
  return {
    borrower: "0xa17DE314e60b455766D030b7CFfE178d912caBd3",
    price,
    coll,
    debt,
    icr,
    icrLocal: icr,
    liqPrice: liq,
    dropBps: dropToLiquidationBps(price, liq),
    tier: rawTier(icr),
    tcr: 3n * WAD,
    recoveryMode: false,
  };
}
const rankAt = (rank: number, size = 255): RankResult => ({ rank, size, percentile: (rank - 1) / (size - 1) });
const far: RankResult = { truncated: true, size: 255 };
const URL = "https://example.test/borrow";

describe("tier alerts", () => {
  it("sends nothing while the tier is unchanged", () => {
    expect(decide({ tier: "safe" }, snapAt(200), far, URL).messages).toEqual([]);
  });

  it("treats a first observation of a healthy trove as a silent baseline", () => {
    const d = decide({}, snapAt(200), far, URL);
    expect(d.messages).toEqual([]);
    expect(d.state.tier).toBe("safe");
  });

  it("alerts on escalation, with the status card and action link", () => {
    const d = decide({ tier: "safe" }, snapAt(118), far, URL);
    expect(d.state.tier).toBe("urgent");
    expect(d.messages).toHaveLength(1);
    expect(d.messages[0]).toContain("moved from SAFE to URGENT");
    expect(d.messages[0]).toContain(URL);
  });

  it("links the dashboard from risky alerts only", () => {
    const d = decide({ tier: "safe" }, snapAt(118), far, URL, "https://site.test/p?a=0x1");
    expect(d.messages[0]).toContain("Open your dashboard: https://site.test/p?a=0x1");
    const none = decide({ tier: "safe" }, snapAt(118), far, URL);
    expect(none.messages[0]).not.toContain("dashboard");
  });

  it("alerts a first observation that is already risky", () => {
    const d = decide({}, snapAt(130), far, URL);
    expect(d.messages[0]).toContain("moved from SAFE to WARNING");
  });

  it("warns that a liquidatable trove can be liquidated now", () => {
    const d = decide({ tier: "urgent" }, snapAt(105), far, URL);
    expect(d.state.tier).toBe("liquidatable");
    expect(d.messages[0]).toContain("can be liquidated right now");
  });

  it("does not alert twice for the same tier", () => {
    const first = decide({ tier: "safe" }, snapAt(118), far, URL);
    const second = decide(first.state, snapAt(117), far, URL);
    expect(second.messages).toEqual([]);
  });

  it("holds the tier inside the hysteresis buffer, then announces improvement", () => {
    // Urgent bound is 120%, buffer 3 points, so 121% must NOT step down yet.
    const held = decide({ tier: "urgent" }, snapAt(121), far, URL);
    expect(held.state.tier).toBe("urgent");
    expect(held.messages).toEqual([]);
    const cleared = decide({ tier: "urgent" }, snapAt(124), far, URL);
    expect(cleared.state.tier).toBe("warning");
    expect(cleared.messages[0]).toContain("Improved");
  });
});

describe("redemption alerts", () => {
  it("zone uses enter and exit ranks with a gap", () => {
    expect(inRedemptionZone(rankAt(REDEMPTION_ENTER_RANK), false)).toBe(true);
    expect(inRedemptionZone(rankAt(REDEMPTION_ENTER_RANK + 1), false)).toBe(false);
    expect(inRedemptionZone(rankAt(REDEMPTION_EXIT_RANK), true)).toBe(true);
    expect(inRedemptionZone(rankAt(REDEMPTION_EXIT_RANK + 1), true)).toBe(false);
    expect(inRedemptionZone(far, true)).toBe(false);
    expect(inRedemptionZone(null, false)).toBe(false);
  });

  it("alerts once when entering the danger zone", () => {
    const first = decide({ tier: "safe", redeemZone: false }, snapAt(200), rankAt(3), URL);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toContain("Redemption exposure");
    expect(first.messages[0]).toContain("3 of 255");
    const again = decide(first.state, snapAt(200), rankAt(4), URL);
    expect(again.messages).toEqual([]);
  });

  it("announces when risk eases", () => {
    const d = decide({ tier: "safe", redeemZone: true }, snapAt(200), far, URL);
    expect(d.messages[0]).toContain("Redemption exposure eased");
    expect(d.state.redeemZone).toBe(false);
  });
});

describe("when the redemption queue was not checked", () => {
  it("leaves redemption state alone and still sends tier alerts", () => {
    const d = decide({ tier: "safe", redeemZone: true }, snapAt(118), undefined, URL);
    expect(d.state.redeemZone).toBe(true);
    expect(d.messages).toHaveLength(1);
    expect(d.messages[0]).toContain("moved from SAFE to URGENT");
    expect(d.messages[0]).not.toContain("Redemption queue");
  });
});

describe("demo price drop", () => {
  it("lowers price and recomputes ratio and tier", () => {
    const base = snapAt(184.94);
    const demo = withPriceDrop(base, 40);
    expect(demo.price).toBe((base.price * 6n) / 10n);
    expect(demo.tier).toBe("urgent"); // 184.94% * 0.6 = about 111%
    expect(demo.icr).toBeLessThan(base.icr);
  });
});
