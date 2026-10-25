import type { Address, PublicClient } from "viem";
import type { Deployment } from "./config.js";
import { addressWord, calls, decodeEntire, multicall, word } from "./multicall.js";
import type { PositionSnapshot, RankResult } from "./reader.js";
import {
  CCR,
  MAX_ICR,
  MCR,
  MUSD_GAS_COMPENSATION,
  computeIcr,
  dropToLiquidationBps,
  liquidationPrice,
  rawTier,
  redemptionPercentile,
} from "./risk.js";

const MAX_TROVES = 20_000; // sanity cap against a corrupted count

/** Mezo's current loan terms, read from the contracts so the planner never goes stale. */
export interface SystemParams {
  /** Smallest loan allowed, in MUSD (18 decimals), checked on the amount borrowed plus the fee. */
  minNetDebt: bigint;
  /** One-off fee on the amount borrowed, as a fraction with 18 decimals (1e15 = 0.1%). Waived in Recovery Mode. */
  borrowingRate: bigint;
  /** Fixed yearly interest for new loans, in basis points (100 = 1%). */
  interestRateBps: number;
}

export interface TroveRow {
  /** Lowercase 0x address. */
  address: string;
  /** Collateral in BTC, 18 decimals, including pending redistributions. */
  coll: bigint;
  /** Total MUSD owed, 18 decimals. */
  debt: bigint;
}

/** What one full read of the protocol looks like. Saved between runs so most minutes need no big read. */
export interface RawSystem {
  price: bigint;
  stabilityPool: bigint;
  troves: TroveRow[];
  /** When it was read, in ms. */
  at: number;
  /** Absent in snapshots saved by older versions. */
  params?: SystemParams;
}

export function serializeRaw(raw: RawSystem): string {
  return JSON.stringify({
    p: raw.price.toString(),
    s: raw.stabilityPool.toString(),
    a: raw.at,
    m: raw.params ? [raw.params.minNetDebt.toString(), raw.params.borrowingRate.toString(), raw.params.interestRateBps] : undefined,
    t: raw.troves.map((t) => [t.address, t.coll.toString(), t.debt.toString()]),
  });
}

export function parseRaw(json: string): RawSystem {
  const o = JSON.parse(json) as { p: string; s: string; a: number; m?: [string, string, number]; t: Array<[string, string, string]> };
  if (!o || typeof o.p !== "string" || !Array.isArray(o.t)) throw new Error("bad snapshot");
  return {
    price: BigInt(o.p),
    stabilityPool: BigInt(o.s ?? "0"),
    at: Number(o.a) || 0,
    params: o.m ? { minNetDebt: BigInt(o.m[0]), borrowingRate: BigInt(o.m[1]), interestRateBps: Number(o.m[2]) } : undefined,
    troves: o.t.map(([address, coll, debt]) => ({ address, coll: BigInt(coll), debt: BigInt(debt) })),
  };
}

/** Full read: price, stability pool, and every trove, in a handful of Multicall requests. */
export async function readSystem(client: PublicClient, dep: Deployment, now: number): Promise<RawSystem> {
  const [priceHex, countHex, poolHex, minHex, feeHex, rateHex] = await multicall(client, [
    calls.price(dep),
    calls.ownersCount(dep),
    calls.poolDeposits(dep),
    calls.minNetDebt(dep),
    calls.borrowingRate(dep),
    calls.interestRate(dep),
  ]);
  if (!priceHex) throw new Error("could not read the BTC price (the oracle may be stale)");
  if (!countHex) throw new Error("could not read the trove count");
  const price = word(priceHex);
  const count = Number(word(countHex));
  if (count > MAX_TROVES) throw new Error(`implausible trove count ${count}`);

  const ownerHexes = await multicall(
    client,
    Array.from({ length: count }, (_, i) => calls.ownerAt(dep, i)),
  );
  const owners = [...new Set(ownerHexes.filter((h): h is NonNullable<typeof h> => h !== null).map((h) => addressWord(h)))];

  const entireHexes = await multicall(client, owners.map((a) => calls.entire(dep, a)));
  const troves: TroveRow[] = [];
  entireHexes.forEach((hex, i) => {
    if (!hex) return;
    const { coll, debt } = decodeEntire(hex);
    if (debt > 0n) troves.push({ address: owners[i]!, coll, debt });
  });

  const params: SystemParams | undefined =
    minHex && feeHex && rateHex ? { minNetDebt: word(minHex), borrowingRate: word(feeHex), interestRateBps: Number(word(rateHex)) } : undefined;
  return { price, stabilityPool: poolHex ? word(poolHex) : 0n, troves, at: now, params };
}

/** Light read: the current price plus fresh numbers for a few addresses. One request in the usual case. */
export async function readFresh(
  client: PublicClient,
  dep: Deployment,
  addresses: string[],
): Promise<{ price: bigint; rows: Map<string, TroveRow | null> }> {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const results = await multicall(client, [calls.price(dep), ...list.map((a) => calls.entire(dep, a))]);
  const priceHex = results[0];
  if (!priceHex) throw new Error("could not read the BTC price (the oracle may be stale)");
  const rows = new Map<string, TroveRow | null>();
  list.forEach((address, i) => {
    const hex = results[i + 1];
    if (!hex) return; // unknown: keep whatever the snapshot has
    const { coll, debt } = decodeEntire(hex);
    rows.set(address, debt > 0n ? { address, coll, debt } : null);
  });
  return { price: priceHex ? word(priceHex) : 0n, rows };
}

export interface QueueEntry extends TroveRow {
  /** 1 means first in line to be redeemed. */
  rank: number;
  /** MUSD that must be redeemed before the queue reaches this trove. */
  musdAhead: bigint;
}

export interface SystemView {
  price: bigint;
  tcr: bigint;
  recoveryMode: boolean;
  troveCount: number;
  redeemableCount: number;
  totalColl: bigint;
  totalDebt: bigint;
  stabilityPool: bigint;
  params?: SystemParams;
  /** When the full snapshot behind this view was read, in ms. */
  snapshotAt: number;
  rows: TroveRow[];
  /** Redemption order: lowest collateral ratio first, skipping troves already below the 110% line. */
  queue: QueueEntry[];
  position(address: string): PositionSnapshot | null;
  rank(address: string): RankResult;
}

/** Lowest collateral-to-debt ratio first. Cross-multiplying avoids any division or rounding. */
const byRatio = (a: TroveRow, b: TroveRow): number => {
  const l = a.coll * b.debt;
  const r = b.coll * a.debt;
  return l < r ? -1 : l > r ? 1 : a.address < b.address ? -1 : 1;
};

export function buildView(
  raw: RawSystem,
  opts: { price?: bigint; overrides?: Map<string, TroveRow | null>; snapshotAt?: number } = {},
): SystemView {
  const price = opts.price ?? raw.price;
  const map = new Map(raw.troves.map((t) => [t.address, t]));
  for (const [address, row] of opts.overrides ?? []) {
    if (row) map.set(address, row);
    else map.delete(address);
  }
  const rows = [...map.values()];

  let totalColl = 0n;
  let totalDebt = 0n;
  for (const r of rows) {
    totalColl += r.coll;
    totalDebt += r.debt;
  }
  const tcr = totalDebt > 0n ? (totalColl * price) / totalDebt : MAX_ICR;

  const redeemable = rows.filter((r) => computeIcr(r.coll, price, r.debt) >= MCR).sort(byRatio);
  const queue: QueueEntry[] = [];
  const index = new Map<string, QueueEntry>();
  let ahead = 0n;
  redeemable.forEach((r, i) => {
    const entry: QueueEntry = { ...r, rank: i + 1, musdAhead: ahead };
    queue.push(entry);
    index.set(r.address, entry);
    ahead += r.debt > MUSD_GAS_COMPENSATION ? r.debt - MUSD_GAS_COMPENSATION : 0n;
  });

  return {
    price,
    tcr,
    recoveryMode: tcr < CCR,
    troveCount: rows.length,
    redeemableCount: queue.length,
    totalColl,
    totalDebt,
    stabilityPool: raw.stabilityPool,
    params: raw.params,
    snapshotAt: opts.snapshotAt ?? raw.at,
    rows,
    queue,

    position(address: string): PositionSnapshot | null {
      const row = map.get(address.toLowerCase());
      if (!row) return null;
      const icr = computeIcr(row.coll, price, row.debt);
      const liq = liquidationPrice(row.coll, row.debt);
      return {
        borrower: address as Address,
        price,
        coll: row.coll,
        debt: row.debt,
        icr,
        icrLocal: icr,
        liqPrice: liq,
        dropBps: dropToLiquidationBps(price, liq),
        tier: rawTier(icr),
        tcr,
        recoveryMode: tcr < CCR,
      };
    },

    rank(address: string): RankResult {
      const e = index.get(address.toLowerCase());
      if (!e) return null; // not active, or already below the liquidation line, so not in the queue
      return { rank: e.rank, size: queue.length, percentile: redemptionPercentile(e.rank, queue.length), musdAhead: e.musdAhead };
    },
  };
}
