import { formatStatus, pct, shortAddress, TIER_EMOJI, TIER_LABEL } from "./format.js";
import type { PositionSnapshot, RankResult } from "./reader.js";
import { nextTier, tierSeverity, type Tier } from "./risk.js";

// Design defaults, not protocol values. A trove enters the redemption danger zone when it is
// among the first ENTER_RANK in the queue, and leaves once it is beyond EXIT_RANK.
// The gap stops the alert from flapping.
export const REDEMPTION_ENTER_RANK = 10;
export const REDEMPTION_EXIT_RANK = 15;

export interface AlertState {
  tier?: Tier;
  redeemZone?: boolean;
}

export interface Decision {
  state: AlertState;
  messages: string[];
}

export function inRedemptionZone(rank: RankResult, wasInZone: boolean): boolean {
  if (!rank || "truncated" in rank) return false;
  return rank.rank <= (wasInZone ? REDEMPTION_EXIT_RANK : REDEMPTION_ENTER_RANK);
}

/** Pure decision logic: given what we last told the user and what the chain says now, what do we send? */
export function decide(
  prev: AlertState,
  snap: PositionSnapshot,
  /** undefined means the redemption queue was not checked this pass, so leave that part alone. */
  rank: RankResult | undefined,
  appUrl: string,
  /** Link to this trove's web dashboard, added to alerts when set. */
  dashboardUrl?: string,
): Decision {
  const short = shortAddress(snap.borrower);
  const messages: string[] = [];

  const before: Tier = prev.tier ?? "safe";
  const tier = nextTier(prev.tier, snap.icr);

  if (tierSeverity(tier) > tierSeverity(before)) {
    const head = `🚨 ALERT: ${short} moved from ${TIER_LABEL[before]} to ${TIER_LABEL[tier]}.`;
    const extra = tier === "liquidatable" ? "\nThis trove can be liquidated right now." : "";
    messages.push(`${head}${extra}\n\n${formatStatus({ ...snap, tier }, rank, appUrl, dashboardUrl)}`);
  } else if (tierSeverity(tier) < tierSeverity(before)) {
    messages.push(
      `${TIER_EMOJI[tier]} Improved: ${short} moved from ${TIER_LABEL[before]} to ${TIER_LABEL[tier]}. Collateral ratio is now ${pct(snap.icr)}.`,
    );
  }

  const wasIn = prev.redeemZone ?? false;
  if (rank === undefined) return { state: { tier, redeemZone: wasIn }, messages };
  const isIn = inRedemptionZone(rank, wasIn);
  if (isIn && !wasIn && rank && !("truncated" in rank)) {
    messages.push(
      `⚠️ Redemption exposure: ${short} is ${rank.rank} of ${rank.size} in the redemption queue (1 = first to be redeemed). ` +
        `A redemption pays your debt down at $1 per MUSD and takes the matching BTC. It is not a liquidation, but you would lose BTC exposure. ` +
        `Raising your collateral ratio moves you back: ${appUrl}`,
    );
  } else if (!isIn && wasIn) {
    messages.push(`✅ Redemption exposure eased: ${short} is no longer near the front of the queue.`);
  }

  return { state: { tier, redeemZone: isIn }, messages };
}
