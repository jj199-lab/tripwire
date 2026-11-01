import type { PositionSnapshot } from "./reader.js";
import { computeIcr, dropToLiquidationBps, rawTier } from "./risk.js";

/**
 * DEMO ONLY. Returns the snapshot as if the BTC price were `dropPct` percent lower.
 * Used to trigger real alerts on a healthy position, for testing and for the demo video.
 * Alerts sent in this mode are clearly labelled.
 */
export function withPriceDrop(snap: PositionSnapshot, dropPct: number): PositionSnapshot {
  const bps = BigInt(Math.round(dropPct * 100));
  const price = (snap.price * (10_000n - bps)) / 10_000n;
  const icr = computeIcr(snap.coll, price, snap.debt);
  return {
    ...snap,
    price,
    icr,
    icrLocal: icr,
    dropBps: dropToLiquidationBps(price, snap.liqPrice),
    tier: rawTier(icr),
  };
}
