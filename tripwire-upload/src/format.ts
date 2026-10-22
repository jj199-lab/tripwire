import { formatUnits } from "viem";
import type { PositionSnapshot, RankResult } from "./reader.js";
import { MCR, type Tier } from "./risk.js";

const HUGE = 10n ** 30n;

export const pct = (wad: bigint): string => (wad > HUGE ? "no debt" : `${(Number(wad) / 1e16).toFixed(2)}%`);

export const usd = (wad: bigint): string =>
  `$${Number(formatUnits(wad, 18)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const btc = (wad: bigint): string =>
  `${Number(formatUnits(wad, 18)).toLocaleString("en-US", { maximumFractionDigits: 6 })} BTC`;

export const musd = (wad: bigint): string =>
  `${Number(formatUnits(wad, 18)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MUSD`;

export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const TIER_EMOJI: Record<Tier, string> = {
  safe: "🟢",
  watch: "🟡",
  warning: "🟠",
  urgent: "🔴",
  liquidatable: "⛔",
};

export const TIER_LABEL: Record<Tier, string> = {
  safe: "SAFE",
  watch: "WATCH",
  warning: "WARNING",
  urgent: "URGENT",
  liquidatable: "LIQUIDATABLE",
};

export function formatRank(rank: RankResult): string {
  if (!rank) return "not in the redemption queue";
  if ("truncated" in rank) return `not near the front (${rank.size} troves in total)`;
  const near = rank.percentile < 0.1 ? "  ⚠️ near the front" : "";
  const ahead = rank.musdAhead !== undefined ? `, about ${Number(formatUnits(rank.musdAhead, 18)).toLocaleString("en-US", { maximumFractionDigits: 0 })} MUSD to be redeemed first` : "";
  return `${rank.rank} of ${rank.size} (1 = first to be redeemed${ahead})${near}`;
}

export function formatStatus(snap: PositionSnapshot, rank: RankResult | undefined, appUrl: string): string {
  const dropPct = (snap.dropBps / 100).toFixed(2);
  const lines = [
    `${TIER_EMOJI[snap.tier]} ${TIER_LABEL[snap.tier]}`,
    `Trove ${shortAddress(snap.borrower)}`,
    "",
    `BTC price: ${usd(snap.price)}`,
    `Collateral: ${btc(snap.coll)}`,
    `Debt: ${musd(snap.debt)}`,
    `Collateral ratio: ${pct(snap.icr)} (liquidation below ${pct(MCR)})`,
    `Liquidation price: ${usd(snap.liqPrice)} (${dropPct}% below the current price)`,
    ...(rank === undefined ? [] : [`Redemption queue: ${formatRank(rank)}`]),
    `System ratio: ${pct(snap.tcr)}${snap.recoveryMode ? " (RECOVERY MODE: new loans need 150%+, and the liquidation line stays at 110%)" : ""}`,
  ];
  if (snap.tier !== "safe") lines.push("", `Add collateral or repay: ${appUrl}`);
  return lines.join("\n");
}
