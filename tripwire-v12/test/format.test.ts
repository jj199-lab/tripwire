import { describe, expect, it } from "vitest";
import { formatRank, formatStatus, pct, usd } from "../src/format.js";
import type { PositionSnapshot } from "../src/reader.js";
import { MAX_ICR, WAD, computeIcr, dropToLiquidationBps, liquidationPrice } from "../src/risk.js";

// Numbers from a real matsnet read: 0.03 BTC at $81,378.69 backing about 2,202 MUSD.
const price = 8_137_869n * 10n ** 16n;
const coll = 3n * 10n ** 16n;
const debt = 2_202_000_212_824_736_685_596n;
const liq = liquidationPrice(coll, debt);
const icr = computeIcr(coll, price, debt);

const snap: PositionSnapshot = {
  borrower: "0xa17DE314e60b455766D030b7CFfE178d912caBd3",
  price,
  coll,
  debt,
  icr,
  icrLocal: icr,
  liqPrice: liq,
  dropBps: dropToLiquidationBps(price, liq),
  tier: "urgent",
  tcr: (29242n * WAD) / 10_000n,
  recoveryMode: false,
};

describe("formatting", () => {
  it("formats percentages and dollars", () => {
    expect(pct(icr)).toBe("110.87%");
    expect(usd(price)).toBe("$81,378.69");
    expect(pct(MAX_ICR)).toBe("no debt");
  });

  it("formats the redemption rank", () => {
    expect(formatRank({ rank: 2, size: 255, percentile: 1 / 254 })).toContain("2 of 255");
    expect(formatRank({ rank: 2, size: 255, percentile: 1 / 254 })).toContain("near the front");
    expect(formatRank({ rank: 200, size: 255, percentile: 0.78 })).not.toContain("near the front");
    expect(formatRank(null)).toContain("not in");
  });

  it("shows how much MUSD must be redeemed before a trove", () => {
    const text = formatRank({ rank: 3, size: 40, percentile: 0.05, musdAhead: 12_345n * 10n ** 18n });
    expect(text).toContain("3 of 40");
    expect(text).toContain("about 12,345 MUSD to be redeemed first");
  });

  it("builds a status message with the action link for risky tiers", () => {
    const msg = formatStatus(snap, { rank: 2, size: 255, percentile: 1 / 254 }, "https://example.test/borrow");
    expect(msg).toContain("URGENT");
    expect(msg).toContain("110.87%");
    expect(msg).toContain("0.78% below the current price");
    expect(msg).toContain("https://example.test/borrow");
    expect(msg).toContain("0xa17D…aBd3");
  });

  it("omits the action link when safe and flags recovery mode", () => {
    const safe = formatStatus({ ...snap, tier: "safe" }, null, "https://example.test/borrow");
    expect(safe).not.toContain("https://example.test/borrow");
    const rm = formatStatus({ ...snap, recoveryMode: true }, null, "x");
    expect(rm).toContain("RECOVERY MODE");
    expect(rm).toContain("liquidation line stays at 110%");
    expect(rm).not.toContain("stricter");
  });
});
