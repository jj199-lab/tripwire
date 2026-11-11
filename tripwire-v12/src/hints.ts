import { NICR_PRECISION } from "./risk.js";

export interface HintRow {
  address: string;
  coll: bigint;
  principal: bigint;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export const nicrOf = (coll: bigint, principal: bigint): bigint => (principal > 0n ? (coll * NICR_PRECISION) / principal : 0n);

/**
 * Where a loan with this nominal ratio would sit in Mezo's sorted list. The list runs from the highest ratio down,
 * so `upper` is the neighbour with the next-higher ratio and `lower` the next-lower one (the zero address at either end).
 * The contract checks the hints and searches from them, so a slightly stale pair only costs a little gas.
 */
export function insertHints(rows: HintRow[], nicr: bigint, exclude?: string): { upper: string; lower: string } {
  const skip = exclude?.toLowerCase();
  const sorted = rows
    .filter((r) => r.address.toLowerCase() !== skip && r.principal > 0n)
    .map((r) => ({ address: r.address.toLowerCase(), nicr: nicrOf(r.coll, r.principal) }))
    .sort((a, b) => (a.nicr === b.nicr ? (a.address < b.address ? -1 : 1) : a.nicr > b.nicr ? -1 : 1)); // highest first
  const i = sorted.findIndex((r) => r.nicr < nicr); // first loan with a lower ratio than ours
  if (i === -1) return { upper: sorted.length ? sorted[sorted.length - 1]!.address : ZERO, lower: ZERO }; // we go at the tail
  return { upper: i === 0 ? ZERO : sorted[i - 1]!.address, lower: sorted[i]!.address };
}
