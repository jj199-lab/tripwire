import { describe, expect, it } from "vitest";
import type { PositionSnapshot } from "../src/reader.js";
import { WAD, CCR, computeIcr, dropToLiquidationBps, liquidationPrice, rawTier } from "../src/risk.js";
import { formatSimulation, simulate } from "../src/simulate.js";

// 0.05 BTC at $80,000 backing 2,000 MUSD: ratio 200%.
const price = 80_000n * WAD;
const coll = (5n * WAD) / 100n;
const debt = 2_000n * WAD;
const icr = computeIcr(coll, price, debt);
const liq = liquidationPrice(coll, debt);
const snap: PositionSnapshot = {
  borrower: "0xa17DE314e60b455766D030b7CFfE178d912caBd3",
  price, coll, debt, icr, icrLocal: icr, liqPrice: liq,
  dropBps: dropToLiquidationBps(price, liq),
  tier: rawTier(icr), tcr: 3n * WAD, recoveryMode: false,
};

describe("simulate", () => {
  it("a 30% drop takes 200% to 140%", () => {
    const sim = simulate(snap, 30);
    expect(sim.after.price).toBe(56_000n * WAD);
    expect(sim.after.icr).toBe((140n * WAD) / 100n);
    expect(sim.tierBefore).toBe("safe");
    expect(sim.tierAfter).toBe("watch");
  });

  it("works out how much to add or repay to get back to 150%", () => {
    const sim = simulate(snap, 30);
    // Needed collateral: 1.5 * 2000 / 56000 BTC = 0.0535714... ; we hold 0.05
    expect(sim.addCollateral).toBeGreaterThan(0n);
    expect(sim.addCollateral).toBeLessThan((4n * WAD) / 1000n);
    // Adding it restores the target ratio (within rounding)
    const restored = computeIcr(coll + sim.addCollateral, sim.after.price, debt);
    expect(restored).toBeGreaterThanOrEqual(CCR - 10n ** 9n);
    // Repaying it also restores the target ratio
    const restored2 = computeIcr(coll, sim.after.price, debt - sim.repayDebt);
    expect(restored2).toBeGreaterThanOrEqual(CCR - 10n ** 9n);
  });

  it("needs no action when still above the target", () => {
    const sim = simulate(snap, 10); // 200% x 0.9 = 180%
    expect(sim.addCollateral).toBe(0n);
    expect(sim.repayDebt).toBe(0n);
    expect(formatSimulation(sim, "https://x.test")).toContain("Still safe at that price.");
  });

  it("flags a drop that would cause liquidation", () => {
    const sim = simulate(snap, 50); // 100%
    expect(sim.tierAfter).toBe("liquidatable");
    const text = formatSimulation(sim, "https://x.test");
    expect(text).toContain("would be liquidatable");
    expect(text).toContain("https://x.test");
    expect(text).toContain("Simulation only");
  });

  it("handles a zero-debt position", () => {
    const sim = simulate({ ...snap, debt: 0n, icr: 2n ** 256n - 1n, liqPrice: 0n }, 30);
    expect(sim.addCollateral).toBe(0n);
    expect(sim.repayDebt).toBe(0n);
  });
});
