import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { priceFeedAbi, sortedTrovesAbi, troveManagerAbi, TROVE_ACTIVE } from "./abi.js";
import { CHAINS, DEPLOYMENTS, type Deployment, type NetworkName } from "./config.js";
import {
  computeIcr,
  dropToLiquidationBps,
  liquidationPrice,
  rawTier,
  redemptionPercentile,
  type RedemptionRank,
  type Tier,
} from "./risk.js";

const ZERO = "0x0000000000000000000000000000000000000000";

export interface ClientOptions {
  /** Override the default public RPC. */
  rpcUrl?: string;
  /**
   * Send reads that happen at the same moment as one JSON-RPC batch request.
   * Cuts the number of HTTP requests a lot (needed on the Cloudflare free plan),
   * but only works if the RPC supports batching. Check with: npm run check -- <address> --batch
   */
  batch?: boolean;
}

export function makeClient(
  network: NetworkName,
  opts: ClientOptions = {},
): { client: PublicClient; deployment: Deployment } {
  const client = createPublicClient({
    chain: CHAINS[network],
    transport: http(opts.rpcUrl, { batch: opts.batch ?? false }),
  }) as PublicClient;
  return { client, deployment: DEPLOYMENTS[network] };
}

export interface PositionSnapshot {
  borrower: Address;
  /** BTC price in USD, 18 decimals. */
  price: bigint;
  /** Collateral in BTC, 18 decimals, including pending redistributions. */
  coll: bigint;
  /** Total MUSD owed: principal + interest + pending, 18 decimals. */
  debt: bigint;
  /** ICR as reported by the contract (authoritative). */
  icr: bigint;
  /** ICR computed locally, used to cross-check the contract. */
  icrLocal: bigint;
  liqPrice: bigint;
  dropBps: number;
  /** Tier from the ratio alone, with no hysteresis. */
  tier: Tier;
  /** System-wide collateral ratio. */
  tcr: bigint;
  recoveryMode: boolean;
}

/**
 * Returns null if the address has no active trove.
 * Uses two rounds of reads. Reads inside a round can be batched into one HTTP request.
 */
export async function readPosition(
  client: PublicClient,
  dep: Deployment,
  borrower: Address,
): Promise<PositionSnapshot | null> {
  const [status, price, entire] = await Promise.all([
    client.readContract({ address: dep.troveManager, abi: troveManagerAbi, functionName: "getTroveStatus", args: [borrower] }),
    client.readContract({ address: dep.priceFeed, abi: priceFeedAbi, functionName: "fetchPrice" }),
    client.readContract({ address: dep.troveManager, abi: troveManagerAbi, functionName: "getEntireDebtAndColl", args: [borrower] }),
  ]);
  if (Number(status) !== TROVE_ACTIVE) return null;

  const [icr, tcr, recoveryMode] = await Promise.all([
    client.readContract({ address: dep.troveManager, abi: troveManagerAbi, functionName: "getCurrentICR", args: [borrower, price] }),
    client.readContract({ address: dep.troveManager, abi: troveManagerAbi, functionName: "getTCR", args: [price] }),
    client.readContract({ address: dep.troveManager, abi: troveManagerAbi, functionName: "checkRecoveryMode", args: [price] }),
  ]);

  const [coll, principal, interest, pendingColl, pendingPrincipal, pendingInterest] = entire;
  const totalColl = coll + pendingColl;
  const debt = principal + interest + pendingPrincipal + pendingInterest;
  const liqPrice = liquidationPrice(totalColl, debt);

  return {
    borrower,
    price,
    coll: totalColl,
    debt,
    icr,
    icrLocal: computeIcr(totalColl, price, debt),
    liqPrice,
    dropBps: dropToLiquidationBps(price, liqPrice),
    tier: rawTier(icr),
    tcr,
    recoveryMode,
  };
}

export type RankResult = RedemptionRank | { truncated: true; size: number } | null;

/**
 * Walks the sorted trove list from the tail, the same place redemptions start
 * (TroveManager.redeemCollateral begins at sortedTroves.getLast and walks getPrev).
 * Returns null if the trove is not in the list, or { truncated } if it is deeper than maxSteps.
 */
export async function readRedemptionRank(
  client: PublicClient,
  dep: Deployment,
  borrower: Address,
  maxSteps = 500,
): Promise<RankResult> {
  const [inList, sizeRaw, last] = await Promise.all([
    client.readContract({ address: dep.sortedTroves, abi: sortedTrovesAbi, functionName: "contains", args: [borrower] }),
    client.readContract({ address: dep.sortedTroves, abi: sortedTrovesAbi, functionName: "getSize" }),
    client.readContract({ address: dep.sortedTroves, abi: sortedTrovesAbi, functionName: "getLast" }),
  ]);
  if (!inList) return null;
  const size = Number(sizeRaw);

  let current = last;
  for (let rank = 1; rank <= maxSteps && current !== ZERO; rank++) {
    if (current.toLowerCase() === borrower.toLowerCase()) {
      return { rank, size, percentile: redemptionPercentile(rank, size) };
    }
    current = await client.readContract({
      address: dep.sortedTroves,
      abi: sortedTrovesAbi,
      functionName: "getPrev",
      args: [current],
    });
  }
  return { truncated: true, size };
}
