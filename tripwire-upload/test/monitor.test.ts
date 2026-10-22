import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { runOnce, type MonitorDeps } from "../src/monitor.js";
import type { PositionSnapshot, RankResult } from "../src/reader.js";
import { WAD, computeIcr, dropToLiquidationBps, liquidationPrice, rawTier } from "../src/risk.js";
import type { StoredState } from "../src/storage.js";
import { JsonStore } from "../src/storage-json.js";

const A = "0xa17DE314e60b455766D030b7CFfE178d912caBd3" as Address;
const mk = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const price = 80_000n * WAD;
const coll = WAD;

function snapAt(icrPct: number, borrower: Address = A): PositionSnapshot {
  const debt = (coll * price * 100n) / (BigInt(Math.round(icrPct * 100)) * WAD) * 100n;
  const icr = computeIcr(coll, price, debt);
  const liq = liquidationPrice(coll, debt);
  return { borrower, price, coll, debt, icr, icrLocal: icr, liqPrice: liq, dropBps: dropToLiquidationBps(price, liq), tier: rawTier(icr), tcr: 3n * WAD, recoveryMode: false };
}

class CountingStore extends JsonStore {
  writes = 0;
  override async setState(chatId: number, address: Address, state: StoredState) {
    this.writes++;
    return super.setState(chatId, address, state);
  }
}

let store: CountingStore;
let sent: Array<{ chatId: number; text: string }>;
let readLog: string[];
let rankCalls: number;
let current: PositionSnapshot | null;
let failSend: boolean;
let rank: RankResult;

function deps(over: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    store,
    appUrl: "https://example.test/borrow",
    readPosition: async (a) => {
      readLog.push(a.toLowerCase());
      return current ? { ...current, borrower: a } : null;
    },
    readRank: async () => {
      rankCalls++;
      return rank;
    },
    send: async (chatId, text) => {
      if (failSend) throw new Error("telegram down");
      sent.push({ chatId, text });
    },
    ...over,
  };
}

beforeEach(async () => {
  store = new CountingStore(join(mkdtempSync(join(tmpdir(), "mon-")), "s.json"));
  sent = [];
  readLog = [];
  rankCalls = 0;
  current = snapAt(200);
  failSend = false;
  rank = { truncated: true, size: 255 };
  await store.add(1, A);
  await store.setState(1, A, { tier: "safe", redeemZone: false });
  store.writes = 0;
});

describe("runOnce", () => {
  it("stays quiet and writes nothing while nothing changes", async () => {
    await runOnce(deps());
    await runOnce(deps());
    expect(sent).toEqual([]);
    expect(store.writes).toBe(0);
  });

  it("alerts when the tier worsens and does not repeat on the next pass", async () => {
    current = snapAt(118);
    await runOnce(deps());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("URGENT");
    expect(store.writes).toBe(1);
    await runOnce(deps());
    expect(sent).toHaveLength(1);
    expect(store.writes).toBe(1);
    expect((await store.list(1))[0]?.tier).toBe("urgent");
  });

  it("reads each address once even when several chats track it", async () => {
    await store.add(2, A);
    await store.setState(2, A, { tier: "safe", redeemZone: false });
    current = snapAt(118);
    await runOnce(deps());
    expect(readLog).toHaveLength(1);
    expect(sent.map((s) => s.chatId).sort()).toEqual([1, 2]);
  });

  it("keeps the old state and retries if sending fails", async () => {
    current = snapAt(118);
    failSend = true;
    await runOnce(deps());
    expect((await store.list(1))[0]?.tier).toBe("safe");
    failSend = false;
    await runOnce(deps());
    expect(sent).toHaveLength(1);
  });

  it("skips a trove whose read fails without touching state", async () => {
    await runOnce(deps({ readPosition: async () => { throw new Error("rpc down"); } }));
    expect(sent).toEqual([]);
    expect((await store.list(1))[0]?.tier).toBe("safe");
  });

  it("tells the user once when an active trove disappears", async () => {
    current = null;
    await runOnce(deps());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("no longer has an active trove");
    await runOnce(deps());
    expect(sent).toHaveLength(1);
  });

  it("stays silent for an address that never had a trove", async () => {
    await store.setState(1, A, {});
    current = null;
    await runOnce(deps());
    expect(sent).toEqual([]);
  });

  it("labels demo-mode alerts clearly", async () => {
    await runOnce(deps({ priceDropPct: 42 })); // 200% x 0.58 = 116%, clearly urgent
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("DEMO MODE (BTC price shifted -42%)");
    expect(sent[0]?.text).toContain("URGENT");
  });
});

describe("per-pass budget and rank checks", () => {
  beforeEach(async () => {
    for (const n of [2, 3]) {
      await store.add(1, mk(n));
      await store.setState(1, mk(n), { tier: "safe", redeemZone: false });
    }
  });

  it("checks only maxAddresses per pass and rotates with the offset", async () => {
    const r0 = await runOnce(deps({ maxAddresses: 1, offset: 0 }));
    expect(r0).toMatchObject({ checked: 1, skipped: 2 });
    const first = readLog[0];
    readLog = [];
    await runOnce(deps({ maxAddresses: 1, offset: 1 }));
    expect(readLog[0]).not.toBe(first);
    readLog = [];
    await runOnce(deps({ maxAddresses: 1, offset: 2 }));
    expect(new Set([first, readLog[0]]).size).toBe(2);
  });

  it("covers every address across consecutive offsets", async () => {
    const seen = new Set<string>();
    for (let offset = 0; offset < 3; offset++) {
      readLog = [];
      await runOnce(deps({ maxAddresses: 1, offset }));
      readLog.forEach((a) => seen.add(a));
    }
    expect(seen.size).toBe(3);
  });

  it("does not read the redemption queue when checkRank is false", async () => {
    rank = { rank: 2, size: 255, percentile: 1 / 254 };
    await runOnce(deps({ checkRank: false }));
    expect(rankCalls).toBe(0);
    expect(sent).toEqual([]);
    await runOnce(deps({ checkRank: true }));
    expect(rankCalls).toBeGreaterThan(0);
    expect(sent.some((s) => s.text.includes("Redemption exposure"))).toBe(true);
  });
});
