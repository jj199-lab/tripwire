import { formatUnits } from "viem";
import type { PositionSnapshot, RankResult } from "./reader.js";
import { CCR, DEFAULT_TIERS, MCR, computeIcr, type Tier } from "./risk.js";
import type { SystemView } from "./system.js";

const n = (wad: bigint): number => Number(formatUnits(wad, 18));
const pct = (wad: bigint): number => Number(wad / 10n ** 14n) / 100; // ratio in percent, 2 decimals

const BUCKETS: Array<[number, number]> = [
  [0, 110],
  [110, 120],
  [120, 135],
  [135, 150],
  [150, 200],
  [200, 300],
  [300, Infinity],
];

/** Everything the public system page needs, as plain numbers. */
export function systemSummary(view: SystemView, nowMs: number) {
  // Work out each trove's ratio once, as a plain number: this runs on every page view, so keep it cheap.
  const rows = view.rows.map((r) => ({ ratio: pct(computeIcr(r.coll, view.price, r.debt)), debt: n(r.debt) }));

  const buckets = BUCKETS.map(([from, to]) => ({ from, to: Number.isFinite(to) ? to : null, troves: 0, debtMusd: 0 }));
  for (const r of rows) {
    const b = BUCKETS.findIndex(([from, to]) => r.ratio >= from && r.ratio < to);
    if (b >= 0) {
      buckets[b]!.troves++;
      buckets[b]!.debtMusd += r.debt;
    }
  }

  // If BTC fell d% from now, how much debt would sit below the liquidation line, and could the Stability Pool absorb it?
  // A trove is liquidatable once ratio x (1 - d/100) < 110, that is ratio < 110 / (1 - d/100).
  const price = n(view.price);
  const pool = n(view.stabilityPool);
  const wall = [];
  for (let d = 0; d <= 60; d += 5) {
    const limit = (pct(MCR) * 100) / (100 - d);
    let troves = 0;
    let debt = 0;
    for (const r of rows) {
      if (r.ratio < limit) {
        troves++;
        debt += r.debt;
      }
    }
    wall.push({ dropPct: d, btcPrice: (price * (100 - d)) / 100, troves, debtMusd: debt, poolCovers: pool >= debt });
  }

  return {
    updatedAt: view.snapshotAt,
    snapshotAgeSec: Math.max(0, Math.round((nowMs - view.snapshotAt) / 1000)),
    btcPrice: n(view.price),
    systemRatioPct: pct(view.tcr),
    recoveryMode: view.recoveryMode,
    troveCount: view.troveCount,
    redeemableCount: view.redeemableCount,
    totalCollateralBtc: n(view.totalColl),
    totalDebtMusd: n(view.totalDebt),
    stabilityPoolMusd: n(view.stabilityPool),
    tiers: tiersSummary(),
    buckets,
    wall,
    queue: view.queue.slice(0, 20).map((e) => ({
      rank: e.rank,
      address: e.address,
      ratioPct: pct(computeIcr(e.coll, view.price, e.debt)),
      debtMusd: n(e.debt),
      collateralBtc: n(e.coll),
      musdAhead: n(e.musdAhead),
    })),
  };
}

/** What the borrow planner needs: today's loan terms, system totals, and every redeemable loan as [ratio %, MUSD that redemptions can take]. */
export function planSummary(view: SystemView, nowMs: number) {
  const gas = 200;
  return {
    btcPrice: n(view.price),
    recoveryMode: view.recoveryMode,
    systemRatioPct: pct(view.tcr),
    totalCollateralBtc: n(view.totalColl),
    totalDebtMusd: n(view.totalDebt),
    snapshotAgeSec: Math.max(0, Math.round((nowMs - view.snapshotAt) / 1000)),
    params: view.params
      ? {
          minLoanMusd: n(view.params.minNetDebt),
          borrowingFeePct: Number(view.params.borrowingRate) / 1e16,
          interestRatePct: view.params.interestRateBps / 100,
          gasDepositMusd: gas,
          liquidationBelowPct: pct(MCR),
          recoveryBelowPct: pct(CCR),
        }
      : null,
    queue: view.queue.map((e) => [pct(computeIcr(e.coll, view.price, e.debt)), Math.max(0, Math.round(n(e.debt) - gas))] as [number, number]),
  };
}

const tiersSummary = () => ({
  liquidationBelowPct: pct(MCR),
  urgentBelowPct: pct(DEFAULT_TIERS.upper.urgent),
  warningBelowPct: pct(DEFAULT_TIERS.upper.warning),
  watchBelowPct: pct(DEFAULT_TIERS.upper.watch),
});

export function positionSummary(snap: PositionSnapshot | null, rank: RankResult, view: SystemView, address: string, tier?: Tier) {
  if (!snap) return { address, active: false, btcPrice: n(view.price) };
  const r = rank && !("truncated" in rank) ? rank : null;
  return {
    address,
    active: true,
    btcPrice: n(snap.price),
    collateralBtc: n(snap.coll),
    debtMusd: n(snap.debt),
    ratioPct: pct(snap.icr),
    tier: tier ?? snap.tier,
    liquidationPrice: n(snap.liqPrice),
    dropToLiquidationPct: snap.dropBps / 100,
    systemRatioPct: pct(snap.tcr),
    recoveryMode: snap.recoveryMode,
    tiers: tiersSummary(),
    redemption: r ? { rank: r.rank, queueSize: r.size, musdAhead: n(r.musdAhead ?? 0n) } : null,
    snapshotAgeSec: Math.max(0, Math.round((Date.now() - view.snapshotAt) / 1000)),
  };
}
