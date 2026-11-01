import { withPriceDrop } from "./demo.js";
import { btc, musd, pct, shortAddress, TIER_EMOJI, TIER_LABEL, usd } from "./format.js";
import type { PositionSnapshot } from "./reader.js";
import { CCR, MCR, rawTier, type Tier } from "./risk.js";

export interface Simulation {
  dropPct: number;
  before: PositionSnapshot;
  after: PositionSnapshot;
  tierBefore: Tier;
  tierAfter: Tier;
  /** Extra collateral (18 decimals) that would restore the target ratio at the simulated price. */
  addCollateral: bigint;
  /** MUSD (18 decimals) to repay that would restore the target ratio at the simulated price. */
  repayDebt: bigint;
  targetIcr: bigint;
}

/** What would happen to this position if BTC fell by `dropPct` percent? Pure maths, nothing on-chain. */
export function simulate(snap: PositionSnapshot, dropPct: number, targetIcr: bigint = CCR): Simulation {
  const after = withPriceDrop(snap, dropPct);
  let addCollateral = 0n;
  let repayDebt = 0n;
  if (snap.debt > 0n && after.price > 0n) {
    const neededColl = (targetIcr * snap.debt) / after.price;
    if (neededColl > snap.coll) addCollateral = neededColl - snap.coll;
    const allowedDebt = (snap.coll * after.price) / targetIcr;
    if (snap.debt > allowedDebt) repayDebt = snap.debt - allowedDebt;
  }
  return {
    dropPct,
    before: snap,
    after,
    tierBefore: rawTier(snap.icr),
    tierAfter: rawTier(after.icr),
    addCollateral,
    repayDebt,
    targetIcr,
  };
}

export function formatSimulation(sim: Simulation, appUrl: string): string {
  const { before, after } = sim;
  const lines = [
    `🧪 What if BTC drops ${sim.dropPct}%?`,
    `Trove ${shortAddress(before.borrower)}`,
    "",
    `BTC price: ${usd(before.price)} → ${usd(after.price)}`,
    `Collateral ratio: ${pct(before.icr)} → ${pct(after.icr)}`,
    `Tier: ${TIER_EMOJI[sim.tierBefore]} ${TIER_LABEL[sim.tierBefore]} → ${TIER_EMOJI[sim.tierAfter]} ${TIER_LABEL[sim.tierAfter]}`,
    `Liquidation price: ${usd(before.liqPrice)}`,
  ];
  if (after.icr < MCR) {
    lines.push("", "⛔ At that price this trove would be liquidatable.");
  } else if (sim.tierAfter === "safe") {
    lines.push("", "Still safe at that price.");
  }
  if (sim.addCollateral > 0n || sim.repayDebt > 0n) {
    lines.push(
      "",
      `To be back at ${pct(sim.targetIcr)} at that price: add ${btc(sim.addCollateral)} or repay ${musd(sim.repayDebt)}.`,
      `Do it here: ${appUrl}`,
    );
  }
  lines.push("", "Simulation only. Nothing changes on-chain.");
  return lines.join("\n");
}
