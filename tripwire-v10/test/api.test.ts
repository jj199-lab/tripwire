import { describe, expect, it } from "vitest";
import { planSummary, positionSummary, systemSummary } from "../src/api.js";
import { WAD } from "../src/risk.js";
import { buildView, type RawSystem, type TroveRow } from "../src/system.js";
import { troveAt } from "./helpers/fakechain.js";

const PRICE = 80_000;
const toRow = (t: ReturnType<typeof troveAt>): TroveRow => ({ address: t.address, coll: t.coll, debt: t.principal });
const troves = [troveAt(0, 105, 2000, PRICE), troveAt(1, 118, 3000, PRICE), troveAt(2, 140, 4000, PRICE), troveAt(3, 190, 5000, PRICE), troveAt(4, 320, 1000, PRICE)];
const raw: RawSystem = { price: BigInt(PRICE) * WAD, stabilityPool: 6_000n * WAD, troves: troves.map(toRow), at: 1_000_000 };
const view = buildView(raw);

describe("systemSummary", () => {
  const s = systemSummary(view, 1_090_000);

  it("reports headline numbers in plain units", () => {
    expect(s.btcPrice).toBe(80_000);
    expect(s.troveCount).toBe(5);
    expect(s.redeemableCount).toBe(4);
    expect(s.totalDebtMusd).toBe(15_000);
    expect(s.stabilityPoolMusd).toBe(6_000);
    expect(s.snapshotAgeSec).toBe(90);
    expect(s.tiers.liquidationBelowPct).toBe(110);
  });

  it("buckets every trove exactly once", () => {
    expect(s.buckets.reduce((n, b) => n + b.troves, 0)).toBe(5);
    expect(s.buckets.reduce((n, b) => n + b.debtMusd, 0)).toBeCloseTo(15_000, 3);
    expect(s.buckets[0]).toMatchObject({ from: 0, to: 110, troves: 1 }); // the 105% trove
    expect(s.buckets[6]).toMatchObject({ from: 300, to: null, troves: 1 }); // the 320% trove
  });

  it("builds a liquidation wall that only grows, and says whether the Stability Pool covers it", () => {
    const debts = s.wall.map((w) => w.debtMusd);
    expect(debts).toEqual([...debts].sort((a, b) => a - b));
    expect(s.wall[0]).toMatchObject({ dropPct: 0, troves: 1, debtMusd: 2_000, poolCovers: true });
    // BTC -10%: the 118% trove falls to 106%, so 5,000 MUSD is exposed against a 6,000 pool
    expect(s.wall.find((w) => w.dropPct === 10)).toMatchObject({ troves: 2, debtMusd: 5_000, poolCovers: true });
    // BTC -30%: 140% -> 98%, so 9,000 MUSD is exposed and the pool no longer covers it
    expect(s.wall.find((w) => w.dropPct === 30)).toMatchObject({ debtMusd: 9_000, poolCovers: false });
    expect(s.wall[s.wall.length - 1]!.dropPct).toBe(60);
  });

  it("lists the first troves in the redemption queue in order, with the MUSD ahead of each", () => {
    expect(s.queue.map((q) => q.rank)).toEqual([1, 2, 3, 4]);
    expect(s.queue[0]!.ratioPct).toBeCloseTo(118, 0);
    expect(s.queue[0]!.musdAhead).toBe(0);
    expect(s.queue[1]!.musdAhead).toBeCloseTo(3_000 - 200, 3);
    expect(s.queue.map((q) => q.ratioPct)).toEqual([...s.queue.map((q) => q.ratioPct)].sort((a, b) => a - b));
  });
});

describe("positionSummary", () => {
  it("describes an active position, with its place in the queue", () => {
    const a = troves[2]!.address;
    const p = positionSummary(view.position(a), view.rank(a), view, a) as Record<string, any>;
    expect(p.active).toBe(true);
    expect(p.ratioPct).toBeCloseTo(140, 0);
    expect(p.debtMusd).toBe(4_000);
    expect(p.redemption).toMatchObject({ rank: 2, queueSize: 4 });
    expect(p.tiers).toEqual({ liquidationBelowPct: 110, urgentBelowPct: 120, warningBelowPct: 135, watchBelowPct: 150 });
    expect(p.dropToLiquidationPct).toBeCloseTo((1 - 110 / 140) * 100, 0);
  });

  it("says plainly when there is no trove", () => {
    const a = "0x" + "9".repeat(40);
    expect(positionSummary(view.position(a), view.rank(a), view, a)).toEqual({ address: a, active: false, btcPrice: 80_000 });
  });

  it("has no redemption entry for a loan already below the liquidation line", () => {
    const a = troves[0]!.address;
    const p = positionSummary(view.position(a), view.rank(a), view, a) as Record<string, any>;
    expect(p.active).toBe(true);
    expect(p.redemption).toBeNull();
  });
});

describe("planSummary", () => {
  const withTerms = buildView({ ...raw, params: { minNetDebt: 1800n * WAD, borrowingRate: WAD / 1000n, interestRateBps: 100 } });
  const plan = planSummary(withTerms, 1_030_000);

  it("reports Mezo's terms in plain units", () => {
    expect(plan.params).toEqual({ minLoanMusd: 1800, borrowingFeePct: 0.1, interestRatePct: 1, gasDepositMusd: 200, liquidationBelowPct: 110, recoveryBelowPct: 150 });
    expect(plan.btcPrice).toBe(80_000);
    expect(plan.totalDebtMusd).toBe(15_000);
    expect(plan.recoveryMode).toBe(false);
    expect(plan.snapshotAgeSec).toBe(30);
  });

  it("lists every redeemable loan as [ratio %, MUSD redemptions can take], lowest ratio first", () => {
    expect(plan.queue).toHaveLength(4); // the 105% loan is below the line, so it is not in the queue
    expect(plan.queue.map((q) => q[0])).toEqual([...plan.queue.map((q) => q[0])].sort((a, b) => a - b));
    expect(plan.queue[0]![0]).toBeCloseTo(118, 0);
    expect(plan.queue[0]![1]).toBe(2_800); // 3,000 debt less the 200 MUSD gas deposit
  });

  it("says so, rather than guessing, when the terms are not known yet", () => {
    expect(planSummary(view, 1_030_000).params).toBeNull();
  });
});
