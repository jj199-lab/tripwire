import { describe, expect, it } from "vitest";
import { DEPLOYMENTS } from "../src/config.js";
import { addressWord, decodeEntire, word } from "../src/multicall.js";
import { MUSD_GAS_COMPENSATION, WAD, computeIcr } from "../src/risk.js";
import { RAW_VERSION, buildView, parseRaw, readFresh, readSystem, serializeRaw, type RawSystem, type TroveRow } from "../src/system.js";
import { fakeClient, troveAt, type FakeTrove } from "./helpers/fakechain.js";

const dep = DEPLOYMENTS.matsnet;
const PRICE = 80_000;
// What the contract reports: stored amounts plus anything pending, counted once.
const toRow = (t: FakeTrove): TroveRow => {
  const principal = t.principal + (t.pendingPrincipal ?? 0n);
  return { address: t.address.toLowerCase(), coll: t.coll + (t.pendingColl ?? 0n), principal, debt: principal + (t.interest ?? 0n) + (t.pendingInterest ?? 0n) };
};

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
    // The first three values already include the pending amounts, which the last three only report.
    expect(decodeEntire(six)).toEqual({ coll: 5n, principal: 100n, interest: 7n, debt: 107n });
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
    expect(parseRaw(serializeRaw(r))).toEqual({ ...r, v: RAW_VERSION }); // saving stamps the version
    expect(() => parseRaw("{}")).toThrow();
  });
});

describe("pending redistributions are counted once", () => {
  // A loan that has been hit by a redistribution: 1 BTC and 2,000 MUSD stored, plus 0.25 BTC and 300 MUSD pending.
  const hit: FakeTrove = { ...troveAt(0, 200, 2000, PRICE), coll: WAD, principal: 2_000n * WAD, interest: 20n * WAD, pendingColl: WAD / 4n, pendingPrincipal: 300n * WAD, pendingInterest: 3n * WAD };

  it("reads collateral and debt exactly as the contract reports them, not with the pending amounts added on again", async () => {
    const { client } = fakeClient({ price: BigInt(PRICE) * WAD, pool: 0n, troves: [hit] });
    const row = (await readSystem(client, dep, 0)).troves[0]!;
    expect(row.coll).toBe(WAD + WAD / 4n); // 1.25 BTC, not 1.5
    expect(row.principal).toBe(2_300n * WAD); // not 2,600
    expect(row.debt).toBe(2_323n * WAD); // principal 2,300 + interest 23, not 2,646
  });

  it("gives the same ratio as the contract's own getCurrentICR would", async () => {
    const { client } = fakeClient({ price: BigInt(PRICE) * WAD, pool: 0n, troves: [hit] });
    const v = buildView(await readSystem(client, dep, 0));
    const expected = computeIcr(WAD + WAD / 4n, BigInt(PRICE) * WAD, 2_323n * WAD); // what getCurrentICR computes
    expect(v.position(hit.address)!.icr).toBe(expected);
  });

  it("holds for fresh single-address reads too", async () => {
    const { client } = fakeClient({ price: BigInt(PRICE) * WAD, pool: 0n, troves: [hit] });
    expect((await readFresh(client, dep, [hit.address])).rows.get(hit.address.toLowerCase())).toEqual(toRow(hit));
  });
});

describe("redemption order follows Mezo's nominal ratio (collateral over principal, interest excluded)", () => {
  it("puts a loan with lots of accrued interest AFTER one the old maths would have put after it", () => {
    // X: 1 BTC on 1,000 principal with 200 interest. Y: 1 BTC on 1,100 principal, no interest.
    // Per unit of total debt X looks weaker (1/1,200 < 1/1,100), but Mezo sorts on principal, where Y is weaker.
    const X: TroveRow = { address: "0x" + "1".repeat(40), coll: WAD, principal: 1_000n * WAD, debt: 1_200n * WAD };
    const Y: TroveRow = { address: "0x" + "2".repeat(40), coll: WAD, principal: 1_100n * WAD, debt: 1_100n * WAD };
    const v = buildView({ price: BigInt(PRICE) * WAD, stabilityPool: 0n, troves: [X, Y], at: 0 });
    expect(v.queue.map((q) => q.address)).toEqual([Y.address, X.address]);
    expect(v.rank(Y.address)).toMatchObject({ rank: 1 });
  });

  it("still takes a loan out of the queue by its real ratio (with interest) once that is under 110%", () => {
    // Principal ratio is 120%, but with interest the loan sits at 105%: Mezo skips it (it will be liquidated).
    const price = 80_000n * WAD;
    const row: TroveRow = { address: "0x" + "3".repeat(40), coll: (1_200n * WAD) / 80_000n, principal: 1_000n * WAD, debt: 1_143n * WAD };
    const v = buildView({ price, stabilityPool: 0n, troves: [row], at: 0 });
    expect(Number(computeIcr(row.coll, price, row.debt)) / 1e16).toBeLessThan(110);
    expect(v.rank(row.address)).toBeNull();
  });
});

describe("saved snapshots", () => {
  it("keep the principal and a version number", () => {
    const back = parseRaw(serializeRaw(raw([A])));
    expect(back.v).toBe(RAW_VERSION);
    expect(back.troves[0]!.principal).toBe(A.principal);
  });

  it("from an older version load, but are marked so they get replaced at once", () => {
    const legacy = JSON.stringify({ p: (80_000n * WAD).toString(), s: "0", a: 1, t: [["0x" + "a".repeat(40), WAD.toString(), (2_000n * WAD).toString()]] });
    const back = parseRaw(legacy);
    expect(back.v).toBeUndefined();
    expect(back.troves[0]!.principal).toBe(2_000n * WAD);
  });
});

describe("Mezo's loan terms", () => {
  const t = [troveAt(0, 150, 2000, PRICE)];
  it("are read from the contracts in the same request as the price", async () => {
    const { client, stats } = fakeClient({ price: BigInt(PRICE) * WAD, pool: 0n, troves: t });
    const sys = await readSystem(client, dep, 0);
    expect(sys.params).toEqual({ minNetDebt: 1800n * WAD, borrowingRate: WAD / 1000n, interestRateBps: 100 });
    expect(stats.requests).toBe(3); // still one request for everything up front
  });

  it("follow whatever the contracts say", async () => {
    const { client } = fakeClient({ price: BigInt(PRICE) * WAD, pool: 0n, troves: t, minNetDebt: 2500n * WAD, borrowingRate: WAD / 200n, interestRateBps: 250 });
    expect((await readSystem(client, dep, 0)).params).toEqual({ minNetDebt: 2500n * WAD, borrowingRate: WAD / 200n, interestRateBps: 250 });
  });

  it("are left out, not guessed, if any of them cannot be read", async () => {
    const { client } = fakeClient({ price: BigInt(PRICE) * WAD, pool: 0n, troves: t, failParams: true });
    const sys = await readSystem(client, dep, 0);
    expect(sys.params).toBeUndefined();
    expect(sys.troves).toHaveLength(1);
  });

  it("survive saving, and old snapshots without them still load", () => {
    const r = { ...raw([A]), params: { minNetDebt: 1800n * WAD, borrowingRate: WAD / 1000n, interestRateBps: 100 } };
    expect(parseRaw(serializeRaw(r))).toEqual({ ...r, v: RAW_VERSION });
    expect(parseRaw(serializeRaw(raw([A]))).params).toBeUndefined();
    expect(buildView(r).params).toEqual(r.params);
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
