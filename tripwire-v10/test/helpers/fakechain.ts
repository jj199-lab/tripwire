import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, toFunctionSelector, type Hex, type PublicClient } from "viem";
import { MULTICALL3 } from "../../src/multicall.js";
import { WAD } from "../../src/risk.js";

const aggregate3Abi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

export interface FakeTrove {
  address: string;
  coll: bigint;
  principal: bigint;
  interest?: bigint;
}
export interface FakeState {
  price: bigint;
  pool: bigint;
  troves: FakeTrove[];
  /** Reject any single request with more calls than this (simulates a node gas cap). */
  maxCallsPerRequest?: number;
  failPrice?: boolean;
  failOwnersCount?: boolean;
  /** Loan terms; defaults match Mezo's: 1,800 MUSD minimum, 0.1% fee, 1% interest. */
  minNetDebt?: bigint;
  borrowingRate?: bigint;
  interestRateBps?: number;
  failParams?: boolean;
}

const sel = (sig: string) => toFunctionSelector(sig);
const S = {
  price: sel("fetchPrice()"),
  count: sel("getTroveOwnersCount()"),
  ownerAt: sel("getTroveFromTroveOwnersArray(uint256)"),
  entire: sel("getEntireDebtAndColl(address)"),
  pool: sel("getTotalMUSDDeposits()"),
  minNetDebt: sel("minNetDebt()"),
  borrowingRate: sel("borrowingRate()"),
  interestRate: sel("interestRate()"),
};
const word = (v: bigint): string => encodeAbiParameters([{ type: "uint256" }], [v]).slice(2);

/** A pretend Mezo chain that only understands Multicall3 and the handful of reads Tripwire makes. */
export function fakeClient(state: FakeState) {
  const stats = { requests: 0, calls: 0 };
  const fail = { success: false, returnData: "0x" as Hex };
  const ok = (hex: string) => ({ success: true, returnData: `0x${hex}` as Hex });

  function dispatch(callData: Hex) {
    const s = callData.slice(0, 10);
    if (s === S.price) return state.failPrice ? fail : ok(word(state.price));
    if (s === S.count) return state.failOwnersCount ? fail : ok(word(BigInt(state.troves.length)));
    if (s === S.ownerAt) {
      const t = state.troves[Number(BigInt(`0x${callData.slice(10, 74)}`))];
      return t ? ok(word(BigInt(t.address))) : fail;
    }
    if (s === S.entire) {
      const addr = `0x${callData.slice(10 + 24, 74)}`.toLowerCase();
      const t = state.troves.find((x) => x.address.toLowerCase() === addr);
      const w = t ? [t.coll, t.principal, t.interest ?? 0n, 0n, 0n, 0n] : [0n, 0n, 0n, 0n, 0n, 0n];
      return ok(w.map(word).join(""));
    }
    if (s === S.pool) return ok(word(state.pool));
    if (s === S.minNetDebt) return state.failParams ? fail : ok(word(state.minNetDebt ?? 1800n * WAD));
    if (s === S.borrowingRate) return state.failParams ? fail : ok(word(state.borrowingRate ?? WAD / 1000n));
    if (s === S.interestRate) return state.failParams ? fail : ok(word(BigInt(state.interestRateBps ?? 100)));
    return fail;
  }

  const client = {
    async call({ to, data }: { to: string; data: Hex }) {
      stats.requests++;
      if (to.toLowerCase() !== MULTICALL3.toLowerCase()) throw new Error(`unexpected call target ${to}`);
      const { args } = decodeFunctionData({ abi: aggregate3Abi, data });
      const calls = args[0] as readonly { target: string; callData: Hex }[];
      if (state.maxCallsPerRequest !== undefined && calls.length > state.maxCallsPerRequest) throw new Error("out of gas");
      stats.calls += calls.length;
      return { data: encodeFunctionResult({ abi: aggregate3Abi, functionName: "aggregate3", result: calls.map((c) => dispatch(c.callData)) }) };
    },
  } as unknown as PublicClient;

  return { client, stats };
}

/** A trove at a given collateral ratio (percent) for a given debt and BTC price. */
export function troveAt(index: number, ratioPct: number, debtMusd: number, priceUsd: number): FakeTrove {
  const debt = BigInt(debtMusd) * WAD;
  const price = BigInt(priceUsd) * WAD;
  return {
    address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    coll: (debt * BigInt(Math.round(ratioPct * 100)) * WAD) / (10_000n * price),
    principal: debt,
  };
}
