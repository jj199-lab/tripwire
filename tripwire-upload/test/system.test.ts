import { describe, expect, it } from "vitest";
import { DEPLOYMENTS } from "../src/config.js";
import { addressWord, decodeEntire, word } from "../src/multicall.js";
import { MUSD_GAS_COMPENSATION, WAD } from "../src/risk.js";
import { buildView, parseRaw, readFresh, readSystem, serializeRaw, type RawSystem, type TroveRow } from "../src/system.js";
import { fakeClient, troveAt, type FakeTrove } from "./helpers/fakechain.js";

const dep = DEPLOYMENTS.matsnet;
const PRICE = 80_000;
const toRow = (t: FakeTrove): TroveRow => ({ address: t.address.toLowerCase(), coll: t.coll, debt: t.principal + (t.interest ?? 0n) });

// A: 105% (below the liquidation line), B: 115%, C: 130%, D: 200%, all with 2,200 MUSD of debt.
const A = troveAt(0, 105, 2200, PRICE);
const B = troveAt(1, 115, 2200, PRICE);
const C = troveAt(2, 130, 2200, PRICE);
const D = troveAt(3, 200, 2200, PRICE);
const raw = (troves: FakeTrove[], pool = 50_000n * WAD): RawSystem => ({ price: BigInt(PRICE) * WAD, stabilityPool: pool, troves: troves.map(toRow), at: 1_000 });

describe("decoding helpers", () => {
  it("reads words, addresses and the six-word trove record", () => {
    const hex = `0x${"0".repeat(63)}1${"0".repeat(24)}${"ab".repeat(20)}` as const;
    expect(word(hex, 0)).toBe(1n);
    expect(addressWord(hex, 1)).toBe(`0x${"ab".repeat(20)}`);
    const six = `0x${[5n, 100n, 7n, 2n, 10n, 3n].map((v) => v.toString(16).padStart(64, "0")).join("")}` as const;
    expect(decodeEntire(six)).toEqual({ coll: 7n, debt: 120n }); // coll 5+2, debt 100+7+10+3
    expect(() => word("0x12", 0)).toThrow(/malformed/);
  });
});

describe("buildView: redemption queue", () => {
  const view = buildView(raw([A, B, C, D]));

  it("counts every trove but queues only those at or above the liquidation line", () => {
    expect(view.troveCount).toBe(4);
    expect(view.redeemableCount).toBe(3);
    expect(view.queue.map((q) => q.address)).toEqual([B, C, D].map((t) => t.address.toLowerCase()));
    expect(view.queue.map((q) => q.rank)).toEqual([1, 2, 3]);
  });

  it("works out how much MUSD must be redeemed before each trove, net of the 200 MUSD gas deposit", () => {
    const net = 2200n * WAD - MUSD_GAS_COMPENSATION;
    expect(view.queue.map((q) => q.musdAhead)).toEqual([0n, net, net * 2n]);
  });

  it("answers rank questions, case-insensitively, and returns null when not in the queue", () => {
    expect(view.rank(C.address.toUpperCase().replace("0X", "0x"))).toMatchObject({ rank: 2, size: 3 });
    expect(view.rank(A.address)).toBeNull(); // below 110%: liquidated first, not redeemable
    expect(view.rank("0x" + "9".repeat(40))).toBeNull();
  });

  it("builds a position with the right ratio, tier and liquidation price", () => {
    const p = view.position(B.address)!;
    expect(Number(p.icr) / 1e16).toBeCloseTo(115, 1);
    expect(p.tier).toBe("urgent");
    expect(Number(p.liqPrice) / 1e18).toBeCloseTo((80_000 * 110) / 115, 0);
    expect(view.position("0x" + "9".repeat(40))).toBeNull();
  });

  it("computes the system ratio and recovery mode from the totals", () => {
    const expected = (view.totalColl * view.price) / view.totalDebt;
    expect(view.tcr).toBe(expected);
    expect(view.recoveryMode).toBe(Number(view.tcr) / 1e16 < 150); // about 137% here
    expect(buildView(raw([D])).recoveryMode).toBe(false);
  });

  it("applies fresh overrides: replace, remove and add", () => {
    const lowerC = troveAt(2, 112, 2200, PRICE);
    const E = troveAt(4, 150, 2200, PRICE);
    const v = buildView(raw([A, B, C, D]), {
      overrides: new Map<string, TroveRow | null>([
        [C.address.toLowerCase(), toRow(lowerC)],
        [D.address.toLowerCase(), null],
        [E.address.toLowerCase(), toRow(E)],
      ]),
    });
    expect(v.queue.map((q) => q.address)).toEqual([lowerC, B, E].map((t) => t.address.toLowerCase()).sort((x, y) => {
      const ratio = (a: string) => Number(v.rows.find((r) => r.address === a)!.coll) / Number(v.rows.find((r) => r.address === a)!.debt);
      return ratio(x) - ratio(y);
    }));
    expect(v.position(D.address)).toBeNull();
    expect(v.troveCount).toBe(4);
  });

  it("drops troves from the queue when a lower price pushes them under the line", () => {
    const v = buildView(raw([A, B, C, D]), { price: BigInt(PRICE - 8_000) * WAD }); // BTC -10%
    expect(v.queue.map((q) => q.address)).not.toContain(B.address.toLowerCase()); // 115% -> 103.5%
    expect(v.rank(B.address)).toBeNull();
  });

  it("survives a save and reload", () => {
    const r = raw([A, B, C, D]);
    expect(parseRaw(serializeRaw(r))).toEqual(r);
    expect(() => parseRaw("{}")).toThrow();
  });
});

describe("reading the chain through Multicall", () => {
  const many = (n: number): FakeTrove[] => Array.from({ length: n }, (_, i) => troveAt(i, 120 + (i % 80), 2000 + i, PRICE));

  it("reads 255 troves in a handful of requests and ignores closed ones", async () => {
    const closed: FakeTrove = { address: "0x" + "f".repeat(40), coll: 0n, principal: 0n };
    const { client, stats } = fakeClient({ price: BigInt(PRICE) * WAD, pool: 1234n * WAD, troves: [...many(254), closed] });
    const sys = await readSystem(client, dep, 42);
    expect(sys.troves).toHaveLength(254);
    expect(sys.price).toBe(BigInt(PRICE) * WAD);
    expect(sys.stabilityPool).toBe(1234n * WAD);
    expect(sys.at).toBe(42);
    expect(stats.requests).toBe(5); // 1 for price/count/pool, 2 for owners, 2 for positions
    expect(sys.troves[10]).toEqual(toRow(many(254)[10]!));
  });

  it("adds interest and pending amounts into the debt", async () => {
    const t: FakeTrove = { ...troveAt(0, 150, 2000, PRICE), interest: 5n * WAD };
    const { client } = fakeClient({ price: BigInt(PRICE) * WAD, pool: 0n, troves: [t] });
    expect((await readSystem(client, dep, 0)).troves[0]!.debt).toBe(2005n * WAD);
  });

  it("splits requests when the node caps how many calls fit in one", async () => {
    const { client, stats } = fakeClient({ price: BigInt(PRICE) * WAD, pool: 0n, troves: many(100), maxCallsPerRequest: 20 });
    const sys = await readSystem(client, dep, 0);
    expect(sys.troves).toHaveLength(100);
    expect(stats.requests).toBeGreaterThan(5);
  });

  it("fails loudly when the oracle price or trove count cannot be read", async () => {
    await expect(readSystem(fakeClient({ price: 1n, pool: 0n, troves: [], failPrice: true }).client, dep, 0)).rejects.toThrow(/price/);
    await expect(readSystem(fakeClient({ price: 1n, pool: 0n, troves: [], failOwnersCount: true }).client, dep, 0)).rejects.toThrow(/count/);
  });

  it("readFresh gets the price and several addresses in one request", async () => {
    const { client, stats } = fakeClient({ price: BigInt(PRICE) * WAD, pool: 0n, troves: [A, B] });
    const { price, rows } = await readFresh(client, dep, [A.address, B.address.toUpperCase().replace("0X", "0x"), "0x" + "9".repeat(40)]);
    expect(stats.requests).toBe(1);
    expect(price).toBe(BigInt(PRICE) * WAD);
    expect(rows.get(A.address.toLowerCase())).toEqual(toRow(A));
    expect(rows.get("0x" + "9".repeat(40))).toBeNull(); // no trove there
  });
});
