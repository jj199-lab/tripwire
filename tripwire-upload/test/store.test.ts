import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseAddress } from "../src/address.js";
import { MAX_TROVES_PER_CHAT } from "../src/storage.js";
import { JsonStore } from "../src/storage-json.js";

const A = "0xa17DE314e60b455766D030b7CFfE178d912caBd3" as const;
const mk = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

let path: string;
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "tg-")), "data", "store.json");
});

describe("JsonStore", () => {
  it("adds, lists and removes", async () => {
    const s = new JsonStore(path);
    expect(await s.add(1, A)).toEqual({ ok: true });
    expect((await s.list(1)).map((e) => e.address)).toEqual([A]);
    expect(await s.remove(1, A.toLowerCase() as `0x${string}`)).toBe(true);
    expect(await s.list(1)).toEqual([]);
    expect(await s.remove(1, A)).toBe(false);
  });

  it("rejects duplicates, ignoring case", async () => {
    const s = new JsonStore(path);
    await s.add(1, A);
    expect(await s.add(1, A.toLowerCase() as `0x${string}`)).toEqual({ ok: false, reason: "exists" });
  });

  it("enforces the per-chat limit", async () => {
    const s = new JsonStore(path);
    for (let i = 1; i <= MAX_TROVES_PER_CHAT; i++) expect((await s.add(7, mk(i))).ok).toBe(true);
    expect(await s.add(7, mk(99))).toEqual({ ok: false, reason: "limit" });
    expect((await s.add(8, mk(99))).ok).toBe(true);
  });

  it("keeps chats separate, persists to disk, lists and counts everything", async () => {
    const s = new JsonStore(path);
    await s.add(1, A);
    await s.add(2, mk(5));
    await s.setState(1, A, { tier: "urgent", redeemZone: true });
    const reloaded = new JsonStore(path);
    expect((await reloaded.list(1))[0]?.tier).toBe("urgent");
    expect((await reloaded.list(1))[0]?.redeemZone).toBe(true);
    expect(await reloaded.list(2)).toHaveLength(1);
    expect(await reloaded.count()).toBe(2);
    expect((await reloaded.listAll()).map((t) => t.chatId).sort()).toEqual([1, 2]);
  });

  it("removes a whole chat", async () => {
    const s = new JsonStore(path);
    await s.add(1, A);
    await s.add(2, mk(5));
    await s.removeChat(1);
    expect(await s.list(1)).toEqual([]);
    expect(await s.list(2)).toHaveLength(1);
  });

  it("survives a corrupt file", async () => {
    await new JsonStore(path).add(1, A);
    writeFileSync(path, "{not json");
    expect(await new JsonStore(path).list(1)).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain("not json");
  });
});

describe("parseAddress", () => {
  it("accepts lowercase and returns the checksum form", () => {
    expect(parseAddress(` ${A.toLowerCase()} `)).toBe(A);
  });
  it("rejects garbage and wrong lengths", () => {
    expect(parseAddress("hello")).toBeNull();
    expect(parseAddress("0x123")).toBeNull();
    expect(parseAddress("")).toBeNull();
  });
});
