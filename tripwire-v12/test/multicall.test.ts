import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MULTICALL3, decodeAggregate3, encodeAggregate3, multicall, type Call } from "../src/multicall.js";
import { fakeClient } from "./helpers/fakechain.js";

const abi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

// Small deterministic random generator so failures are reproducible.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const hex = (bytes: number): string => Array.from({ length: bytes }, () => Math.floor(rnd() * 256).toString(16).padStart(2, "0")).join("");

describe("the hand-written aggregate3 codec matches viem exactly", () => {
  it("encodes the same calldata for many random call lists", () => {
    for (let round = 0; round < 60; round++) {
      const n = Math.floor(rnd() * 40);
      const list: Call[] = Array.from({ length: n }, () => ({
        target: `0x${hex(20)}` as Hex,
        data: `0x${hex([4, 36, 68, 5, 100][Math.floor(rnd() * 5)]!)}` as Hex,
      }));
      const expected = encodeFunctionData({
        abi,
        functionName: "aggregate3",
        args: [list.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))],
      });
      expect(encodeAggregate3(list)).toBe(expected);
    }
  });

  it("decodes the same results for many random responses, including failures and odd lengths", () => {
    for (let round = 0; round < 60; round++) {
      const n = Math.floor(rnd() * 40);
      const results = Array.from({ length: n }, () => {
        const success = rnd() > 0.2;
        const len = [0, 32, 192, 33, 64, 1][Math.floor(rnd() * 6)]!;
        return { success, returnData: `0x${hex(len)}` as Hex };
      });
      const data = encodeFunctionResult({ abi, functionName: "aggregate3", result: results });
      const viem = decodeFunctionResult({ abi, functionName: "aggregate3", data }).map((r) => (r.success && r.returnData !== "0x" ? r.returnData : null));
      expect(decodeAggregate3(data)).toEqual(viem);
    }
  });

  it("handles an empty list", () => {
    expect(decodeAggregate3(encodeFunctionResult({ abi, functionName: "aggregate3", result: [] }))).toEqual([]);
    expect(encodeAggregate3([])).toBe(encodeFunctionData({ abi, functionName: "aggregate3", args: [[]] }));
  });
});

describe("multicall()", () => {
  it("marks failed calls as null and keeps results in order", async () => {
    const { client } = fakeClient({ price: 7n, pool: 0n, troves: [], failPrice: true });
    const sel = (s: string) => s;
    const res = await multicall(client, [
      { target: "0x" + "1".repeat(40) as Hex, data: "0x" + sel("c0c4c4a0") as Hex }, // unknown selector -> fails
      { target: "0x" + "2".repeat(40) as Hex, data: "0x" + sel("c0c4c4a0") as Hex },
    ]);
    expect(res).toEqual([null, null]);
  });

  it("sends calls to the canonical Multicall3 address", () => {
    expect(MULTICALL3).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
  });
});
