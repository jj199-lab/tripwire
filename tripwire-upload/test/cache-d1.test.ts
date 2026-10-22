import { describe, expect, it } from "vitest";
import { D1Cache, prunePriceHistory, readPriceHistory, recordPrice } from "../src/cache-d1.js";
import { WAD } from "../src/risk.js";
import type { RawSystem } from "../src/system.js";
import { fakeD1, hasSqlite } from "./helpers/fakeD1.js";

const raw: RawSystem = { price: 81_000n * WAD, stabilityPool: 5n * WAD, at: 123, troves: [{ address: "0x" + "a".repeat(40), coll: 3n * WAD, debt: 2_000n * WAD }] };

describe.skipIf(!hasSqlite)("D1 cache and price history", () => {
  it("saves, reloads and overwrites the system snapshot", async () => {
    const c = new D1Cache(fakeD1());
    expect(await c.get()).toBeNull();
    await c.set(raw, 1000);
    expect(await c.get()).toEqual({ raw, savedAt: 1000 });
    await c.set({ ...raw, price: 1n }, 2000);
    expect((await c.get())!.savedAt).toBe(2000);
    expect((await c.get())!.raw.price).toBe(1n);
  });

  it("treats an unreadable snapshot as missing instead of crashing", async () => {
    const db = fakeD1();
    await db.prepare("INSERT INTO system_cache (key, value, updated_at) VALUES ('snapshot', 'not json', 1)").run();
    expect(await new D1Cache(db).get()).toBeNull();
  });

  it("records one price per minute, reads a window and prunes old rows", async () => {
    const db = fakeD1();
    await recordPrice(db, 60_000 * 10 + 5_000, 80_000.5);
    await recordPrice(db, 60_000 * 10 + 50_000, 80_100); // same minute: replaces
    await recordPrice(db, 60_000 * 11, 80_200);
    await recordPrice(db, 60_000 * 12, 80_300);
    expect(await readPriceHistory(db, 0)).toEqual([
      { ts: 600_000, price: 80_100 },
      { ts: 660_000, price: 80_200 },
      { ts: 720_000, price: 80_300 },
    ]);
    expect((await readPriceHistory(db, 660_000)).length).toBe(2);
    await prunePriceHistory(db, 700_000);
    expect((await readPriceHistory(db, 0)).map((r) => r.ts)).toEqual([720_000]);
  });
});
