import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEPLOYMENTS } from "../src/config.js";
import { runMonitorPass } from "../src/monitor.js";
import { WAD } from "../src/risk.js";
import { JsonStore } from "../src/storage-json.js";
import { MemoryCache, ViewCache, ViewLoader, FULL_REFRESH_MS } from "../src/viewloader.js";
import { fakeClient, troveAt, type FakeState } from "./helpers/fakechain.js";

const PRICE = 80_000;
const A = troveAt(0, 200, 2200, PRICE);
const B = troveAt(1, 130, 2200, PRICE);

let state: FakeState;
let clock: number;
let fake: ReturnType<typeof fakeClient>;
let loader: ViewLoader;

beforeEach(() => {
  state = { price: BigInt(PRICE) * WAD, pool: 10_000n * WAD, troves: [A, B] };
  clock = 1_000_000;
  fake = fakeClient(state);
  loader = new ViewLoader({ client: fake.client, deployment: DEPLOYMENTS.matsnet, cache: new MemoryCache(), now: () => clock });
});

describe("ViewLoader", () => {
  it("does a full read first, then only a one-request top-up", async () => {
    const v1 = await loader.load([A.address]);
    expect(fake.stats.requests).toBe(3); // price/count/pool, owners, positions
    expect(v1.troveCount).toBe(2);

    fake.stats.requests = 0;
    clock += 60_000;
    state.price = BigInt(PRICE - 4_000) * WAD; // BTC fell 5%
    const v2 = await loader.load([A.address]);
    expect(fake.stats.requests).toBe(1);
    expect(v2.price).toBe(BigInt(PRICE - 4_000) * WAD);
    expect(v2.position(A.address)!.price).toBe(BigInt(PRICE - 4_000) * WAD);
    expect(v2.snapshotAt).toBe(1_000_000); // the trove list is still the earlier snapshot
  });

  it("picks up a changed position for a tracked address without a full read", async () => {
    await loader.load([A.address]);
    state.troves = [{ ...A, coll: A.coll * 2n }, B]; // the owner added collateral
    const v = await loader.load([A.address]);
    expect(v.position(A.address)!.coll).toBe(A.coll * 2n);
    expect(v.position(B.address)!.coll).toBe(B.coll); // untracked: still the snapshot value
  });

  it("re-reads everything after the refresh interval or when forced", async () => {
    await loader.load([]);
    fake.stats.requests = 0;
    clock += FULL_REFRESH_MS - 1;
    await loader.load([]);
    expect(fake.stats.requests).toBe(1);
    clock += 2;
    await loader.load([]);
    expect(fake.stats.requests).toBe(1 + 3);
    fake.stats.requests = 0;
    await loader.load([], { forceFull: true });
    expect(fake.stats.requests).toBe(3);
  });

  it("refreshes straight away when the saved snapshot has no loan terms (an older version saved it)", async () => {
    const cache = new MemoryCache();
    await cache.set({ price: BigInt(PRICE) * WAD, stabilityPool: 0n, troves: [], at: clock }, clock);
    const l = new ViewLoader({ client: fake.client, deployment: DEPLOYMENTS.matsnet, cache, now: () => clock });
    const view = await l.load([]);
    expect(view.params).toBeDefined();
    expect(view.troveCount).toBe(2);
    expect((await cache.get())!.raw.params).toBeDefined();
  });

  it("falls back to the saved snapshot when a full refresh fails", async () => {
    await loader.load([]);
    state.failOwnersCount = true;
    clock += FULL_REFRESH_MS + 1;
    const v = await loader.load([A.address]);
    expect(v.troveCount).toBe(2);
    expect(v.snapshotAt).toBe(1_000_000);
  });

  it("throws when there is nothing saved and the read fails", async () => {
    state.failPrice = true;
    await expect(loader.load([])).rejects.toThrow(/price/);
  });
});

describe("ViewCache", () => {
  it("shares one load between identical lookups within the window, then reloads", async () => {
    let loads = 0;
    let t = 0;
    const cache = new ViewCache(async (a) => { loads++; return loader.load(a); }, 20_000, () => t);
    await Promise.all([cache.get([A.address]), cache.get([A.address.toUpperCase().replace("0X", "0x")])]);
    expect(loads).toBe(1);
    t = 19_000;
    await cache.get([A.address]);
    expect(loads).toBe(1);
    t = 21_000;
    await cache.get([A.address]);
    expect(loads).toBe(2);
    await cache.get([B.address]);
    expect(loads).toBe(3);
  });

  it("does not remember a failed load", async () => {
    let n = 0;
    const cache = new ViewCache(async () => { if (n++ === 0) throw new Error("rpc down"); return loader.load([]); });
    await expect(cache.get([A.address])).rejects.toThrow();
    await expect(cache.get([A.address])).resolves.toBeTruthy();
  });

  it("gives handlers position and rank readers", async () => {
    const { readPosition, readRank } = new ViewCache((a) => loader.load(a)).readers();
    expect((await readPosition(A.address))!.coll).toBe(A.coll);
    expect(await readRank(B.address)).toMatchObject({ rank: 1, size: 2 });
    expect(await readPosition("0x" + "9".repeat(40))).toBeNull();
  });
});

describe("runMonitorPass", () => {
  it("loads once, alerts on a change, records the price and stays quiet afterwards", async () => {
    const store = new JsonStore(join(mkdtempSync(join(tmpdir(), "pass-")), "s.json"));
    await store.add(1, A.address as `0x${string}`);
    await store.setState(1, A.address as `0x${string}`, { tier: "safe", redeemZone: false });
    const sent: string[] = [];
    const prices: bigint[] = [];
    const opts = {
      store, loader, appUrl: "https://x.test",
      send: async (_c: number, t: string) => { sent.push(t); },
      onView: (v: { price: bigint }) => { prices.push(v.price); },
    };

    // With only two healthy loans in this tiny system, A is 2nd in the redemption queue, so it hears about that.
    await runMonitorPass(opts);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Redemption exposure");
    expect(prices).toEqual([BigInt(PRICE) * WAD]);

    clock += 60_000;
    state.price = BigInt(40_000) * WAD; // BTC halves: 200% -> 100%
    await runMonitorPass(opts);
    expect(sent.some((m) => m.includes("LIQUIDATABLE"))).toBe(true);
    expect(sent.some((m) => m.includes("Redemption exposure eased"))).toBe(true); // under 110% it leaves the queue

    const before = sent.length;
    clock += 60_000;
    await runMonitorPass(opts);
    expect(sent).toHaveLength(before); // no repeats
    expect(prices).toHaveLength(3);
  });

  it("still loads and records the price when nothing is tracked", async () => {
    const store = new JsonStore(join(mkdtempSync(join(tmpdir(), "pass-")), "s.json"));
    const prices: bigint[] = [];
    const r = await runMonitorPass({ store, loader, appUrl: "x", send: async () => {}, onView: (v) => { prices.push(v.price); } });
    expect(r.checked).toBe(0);
    expect(prices).toHaveLength(1);
  });
});
