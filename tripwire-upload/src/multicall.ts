import { toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import type { Deployment } from "./config.js";

/**
 * Reads many contract values in one HTTP request through Multicall3, which is deployed at the
 * same address on Mezo testnet as on most chains. This is what keeps the hosted bot inside
 * Cloudflare's free-plan limit on outgoing requests.
 */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export interface Call {
  target: Address;
  data: Hex;
}

export const DEFAULT_CHUNK = 150;
const MIN_CHUNK = 10;

/** Returns one entry per call: the raw return data, or null if that call failed or returned nothing. */
export async function multicall(client: PublicClient, list: Call[], chunkSize = DEFAULT_CHUNK): Promise<(Hex | null)[]> {
  const out: (Hex | null)[] = [];
  for (let i = 0; i < list.length; i += chunkSize) out.push(...(await runChunk(client, list.slice(i, i + chunkSize))));
  return out;
}

async function runChunk(client: PublicClient, chunk: Call[]): Promise<(Hex | null)[]> {
  try {
    const res = await client.call({ to: MULTICALL3, data: encodeAggregate3(chunk) });
    if (!res.data) throw new Error("empty multicall response");
    const results = decodeAggregate3(res.data);
    if (results.length !== chunk.length) throw new Error("multicall returned the wrong number of results");
    return results;
  } catch (err) {
    // The node may cap the gas of a single eth_call. Split the batch in half and try again.
    if (chunk.length <= MIN_CHUNK) throw err;
    const mid = Math.ceil(chunk.length / 2);
    return [...(await runChunk(client, chunk.slice(0, mid))), ...(await runChunk(client, chunk.slice(mid)))];
  }
}

// ---- A small, fast ABI codec for Multicall3's aggregate3 only. ----
// The general-purpose encoder in viem costs about 10 ms of CPU for a full read of 255 troves, which is over
// Cloudflare's free-plan limit. These few string operations are dozens of times cheaper, and the tests
// check them against viem's own encoder and decoder.

const AGGREGATE3 = "82ad56cb"; // aggregate3((address,bool,bytes)[])
const w = (n: number): string => n.toString(16).padStart(64, "0");

/** The full calldata for aggregate3, with allowFailure set on every call. */
export function encodeAggregate3(list: Call[]): Hex {
  const tuples: string[] = [];
  const sizes: number[] = [];
  for (const c of list) {
    const body = c.data.slice(2);
    const bytes = body.length / 2;
    const padded = body.padEnd(Math.ceil(bytes / 32) * 64, "0");
    const t = c.target.slice(2).toLowerCase().padStart(64, "0") + w(1) + w(0x60) + w(bytes) + padded;
    tuples.push(t);
    sizes.push(t.length / 2);
  }
  let offset = list.length * 32;
  const offsets: string[] = [];
  for (const size of sizes) {
    offsets.push(w(offset));
    offset += size;
  }
  return `0x${AGGREGATE3}${w(0x20)}${w(list.length)}${offsets.join("")}${tuples.join("")}`;
}

/** Decodes aggregate3's result into return data, or null for each call that failed or returned nothing. */
export function decodeAggregate3(data: Hex): (Hex | null)[] {
  const hex = data.slice(2);
  const num = (pos: number): number => Number.parseInt(hex.slice(pos + 48, pos + 64), 16); // low 8 bytes is plenty
  const arrayStart = num(0) * 2;
  const n = num(arrayStart);
  const base = arrayStart + 64; // the offsets are measured from just after the length word
  const out: (Hex | null)[] = [];
  for (let i = 0; i < n; i++) {
    const t = base + num(base + i * 64) * 2;
    const success = hex[t + 63] === "1";
    const lengthPos = t + num(t + 64) * 2; // the bytes offset is measured from the start of the tuple
    const length = num(lengthPos);
    out.push(success && length > 0 ? (`0x${hex.slice(lengthPos + 64, lengthPos + 64 + length * 2)}` as Hex) : null);
  }
  return out;
}

const sel = (signature: string): string => toFunctionSelector(signature).slice(2);
const SEL = {
  fetchPrice: sel("fetchPrice()"),
  ownersCount: sel("getTroveOwnersCount()"),
  ownerAt: sel("getTroveFromTroveOwnersArray(uint256)"),
  entire: sel("getEntireDebtAndColl(address)"),
  poolDeposits: sel("getTotalMUSDDeposits()"),
};

const pad = (hexNoPrefix: string): string => hexNoPrefix.padStart(64, "0");

/** Cheap hand-built calldata for the few reads we make, so building hundreds of calls costs almost no CPU. */
export const calls = {
  price: (d: Deployment): Call => ({ target: d.priceFeed, data: `0x${SEL.fetchPrice}` }),
  ownersCount: (d: Deployment): Call => ({ target: d.troveManager, data: `0x${SEL.ownersCount}` }),
  ownerAt: (d: Deployment, index: number): Call => ({ target: d.troveManager, data: `0x${SEL.ownerAt}${pad(index.toString(16))}` }),
  entire: (d: Deployment, borrower: string): Call => ({
    target: d.troveManager,
    data: `0x${SEL.entire}${pad(borrower.toLowerCase().replace(/^0x/, ""))}`,
  }),
  poolDeposits: (d: Deployment): Call => ({ target: d.stabilityPool, data: `0x${SEL.poolDeposits}` }),
};

function need(hex: Hex, words: number): void {
  if (hex.length < 2 + words * 64) throw new Error(`malformed return data (${hex.length} chars, expected ${words} words)`);
}

/** The i-th 32-byte word as a number. */
export function word(hex: Hex, i = 0): bigint {
  need(hex, i + 1);
  return BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
}

export function addressWord(hex: Hex, i = 0): string {
  need(hex, i + 1);
  return `0x${hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`.toLowerCase();
}

/** getEntireDebtAndColl: collateral and total debt, including pending redistributions and interest. */
export function decodeEntire(hex: Hex): { coll: bigint; debt: bigint } {
  need(hex, 6);
  return { coll: word(hex, 0) + word(hex, 3), debt: word(hex, 1) + word(hex, 2) + word(hex, 4) + word(hex, 5) };
}
