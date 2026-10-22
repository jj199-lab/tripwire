import { describe, expect, it } from "vitest";
import { MAX_TROVES_PER_CHAT } from "../src/storage.js";
import { D1Store } from "../src/storage-d1.js";
import { fakeD1, hasSqlite } from "./helpers/fakeD1.js";

const A = "0xa17DE314e60b455766D030b7CFfE178d912caBd3" as const;
const mk = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

describe.skipIf(!hasSqlite)("D1Store", () => {
  it("adds, lists, removes and counts", async () => {
    const s = new D1Store(fakeD1());
    expect(await s.add(1, A)).toEqual({ ok: true });
    expect(await s.add(2, mk(5))).toEqual({ ok: true });
    expect(await s.count()).toBe(2);
    const list = await s.list(1);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ address: A, redeemZone: false });
    expect(list[0]?.tier).toBeUndefined();
    expect(await s.remove(1, A.toLowerCase() as `0x${string}`)).toBe(true);
    expect(await s.remove(1, A)).toBe(false);
    expect(await s.count()).toBe(1);
  });

  it("rejects duplicates ignoring case and enforces the per-chat limit", async () => {
    const s = new D1Store(fakeD1());
    await s.add(1, A);
    expect(await s.add(1, A.toLowerCase() as `0x${string}`)).toEqual({ ok: false, reason: "exists" });
    for (let i = 1; i < MAX_TROVES_PER_CHAT; i++) expect((await s.add(1, mk(i))).ok).toBe(true);
    expect(await s.add(1, mk(99))).toEqual({ ok: false, reason: "limit" });
    expect((await s.add(2, mk(99))).ok).toBe(true);
  });

  it("stores alert state and returns everything in one listAll", async () => {
    const s = new D1Store(fakeD1());
    await s.add(1, A);
    await s.add(2, mk(5));
    await s.setState(1, A, { tier: "urgent", redeemZone: true });
    const all = await s.listAll();
    expect(all).toHaveLength(2);
    const mine = all.find((t) => t.chatId === 1)!;
    expect(mine).toMatchObject({ tier: "urgent", redeemZone: true, address: A });
    await s.setState(1, A, {});
    expect((await s.list(1))[0]).toMatchObject({ redeemZone: false });
    expect((await s.list(1))[0]?.tier).toBeUndefined();
  });

  it("removes a whole chat", async () => {
    const s = new D1Store(fakeD1());
    await s.add(1, A);
    await s.add(1, mk(5));
    await s.add(2, mk(6));
    await s.removeChat(1);
    expect(await s.list(1)).toEqual([]);
    expect(await s.count()).toBe(1);
  });
});
