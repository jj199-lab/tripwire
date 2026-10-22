// Pure risk math. All ratios and prices are 18-decimal fixed point (WAD) bigints,
// matching the MUSD contracts (MCR = 1.1e18 in LiquityBase.sol).

export const WAD = 10n ** 18n;
export const MCR = (11n * WAD) / 10n; // 110%: below this a trove can be liquidated
export const CCR = (15n * WAD) / 10n; // 150%: system TCR below this means Recovery Mode
/** Every trove carries 200 MUSD of gas compensation that redemptions do not touch. */
export const MUSD_GAS_COMPENSATION = 200n * WAD;
export const MAX_ICR = 2n ** 256n - 1n; // what Liquity-style contracts return for zero debt

export type Tier = "safe" | "watch" | "warning" | "urgent" | "liquidatable";

const SEVERITY: Record<Tier, number> = { safe: 0, watch: 1, warning: 2, urgent: 3, liquidatable: 4 };

// Design defaults, not protocol values. Tune after testing. A trove is in a tier
// while its ICR is below that tier's upper bound.
export interface TierConfig {
  upper: Record<Exclude<Tier, "safe">, bigint>;
  /** ICR must clear a tier's bound by this much before we step down out of it. */
  hysteresis: bigint;
}

export const DEFAULT_TIERS: TierConfig = {
  upper: {
    liquidatable: MCR, // below 110%
    urgent: (12n * WAD) / 10n, // below 120%
    warning: (135n * WAD) / 100n, // below 135%
    watch: CCR, // below 150%
  },
  hysteresis: (3n * WAD) / 100n, // 3 percentage points
};

export function computeIcr(coll: bigint, price: bigint, debt: bigint): bigint {
  if (debt === 0n) return MAX_ICR;
  return (coll * price) / debt;
}

/** Price at which ICR hits `mcr`. Returns 0n if there is no collateral-backed debt. */
export function liquidationPrice(coll: bigint, debt: bigint, mcr: bigint = MCR): bigint {
  if (coll === 0n || debt === 0n) return 0n;
  return (mcr * debt) / coll;
}

/** How far the BTC price can fall before liquidation, in basis points (4500 = 45%). */
export function dropToLiquidationBps(price: bigint, liqPrice: bigint): number {
  if (price <= 0n || price <= liqPrice) return 0;
  return Number(((price - liqPrice) * 10_000n) / price);
}

export function rawTier(icr: bigint, cfg: TierConfig = DEFAULT_TIERS): Tier {
  if (icr < cfg.upper.liquidatable) return "liquidatable";
  if (icr < cfg.upper.urgent) return "urgent";
  if (icr < cfg.upper.warning) return "warning";
  if (icr < cfg.upper.watch) return "watch";
  return "safe";
}

/**
 * Escalate immediately, de-escalate only after ICR clears the previous tier's
 * upper bound plus the hysteresis buffer. Stops alert spam near a threshold.
 */
export function nextTier(prev: Tier | undefined, icr: bigint, cfg: TierConfig = DEFAULT_TIERS): Tier {
  const raw = rawTier(icr, cfg);
  if (prev === undefined || prev === "safe" || SEVERITY[raw] >= SEVERITY[prev]) return raw;
  const bound = cfg.upper[prev];
  return icr >= bound + cfg.hysteresis ? raw : prev;
}

export function tierSeverity(t: Tier): number {
  return SEVERITY[t];
}

/** Position in the redemption queue. rank 1 means first in line to be redeemed. */
export interface RedemptionRank {
  rank: number;
  size: number;
  /** 0 to 1, where 0 is the very front of the redemption queue. */
  percentile: number;
  /** MUSD that must be redeemed before the queue reaches this trove. */
  musdAhead?: bigint;
}

export function redemptionPercentile(rank: number, size: number): number {
  if (size <= 1) return 0;
  return (rank - 1) / (size - 1);
}
