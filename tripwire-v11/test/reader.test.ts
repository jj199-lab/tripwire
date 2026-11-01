import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { DEPLOYMENTS } from "../src/config.js";
import { readPosition } from "../src/reader.js";
import { WAD, computeIcr } from "../src/risk.js";

// A pretend contract that answers like TroveManager: getEntireDebtAndColl already includes the pending amounts.
const price = 80_000n * WAD;
const entire = [WAD + WAD / 4n, 2_300n * WAD, 23n * WAD, WAD / 4n, 300n * WAD, 3n * WAD] as const;
const client = {
  async readContract({ functionName }: { functionName: string }) {
    switch (functionName) {
      case "getTroveStatus": return 1;
      case "fetchPrice": return price;
      case "getEntireDebtAndColl": return entire;
      case "getCurrentICR": return computeIcr(entire[0], price, entire[1] + entire[2]);
      case "getTCR": return 3n * WAD;
      case "checkRecoveryMode": return false;
      default: throw new Error(`unexpected ${functionName}`);
    }
  },
} as unknown as PublicClient;

describe("the direct cross-check reader", () => {
  it("uses the contract's totals as they are, so it agrees with getCurrentICR after a redistribution", async () => {
    const snap = await readPosition(client, DEPLOYMENTS.matsnet, ("0x" + "1".repeat(40)) as `0x${string}`);
    expect(snap!.coll).toBe(WAD + WAD / 4n);
    expect(snap!.debt).toBe(2_323n * WAD);
    expect(snap!.icrLocal).toBe(snap!.icr); // local maths and the contract agree
  });
});
