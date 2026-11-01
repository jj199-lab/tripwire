import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { createBot, type BotDeps } from "../src/handlers.js";
import type { PositionSnapshot, RankResult } from "../src/reader.js";
import { WAD, computeIcr, dropToLiquidationBps, liquidationPrice, rawTier } from "../src/risk.js";
import { JsonStore } from "../src/storage-json.js";

const A = "0xa17DE314e60b455766D030b7CFfE178d912caBd3" as Address;
const price = 80_000n * WAD;
const coll = (5n * WAD) / 100n;
const debt = 2_000n * WAD; // 200%
const icr = computeIcr(coll, price, debt);
const liq = liquidationPrice(coll, debt);
const snap: PositionSnapshot = {
  borrower: A, price, coll, debt, icr, icrLocal: icr, liqPrice: liq,
  dropBps: dropToLiquidationBps(price, liq), tier: rawTier(icr), tcr: 3n * WAD, recoveryMode: false,
};

let store: JsonStore;
let replies: string[];
let payloads: Array<Record<string, any>>;
let rankStepsUsed: number[];
let position: PositionSnapshot | null;
let maxTotal: number;
const rank: RankResult = { rank: 185, size: 255, percentile: 0.72 };

function makeBot(over: Partial<BotDeps> = {}) {
  const bot = createBot("123:fake", {
    store,
    readPosition: async () => position,
    readRank: async (_a, steps) => {
      rankStepsUsed.push(steps);
      return rank;
    },
    appUrl: "https://example.test/borrow",
    pollSeconds: 60,
    statusRankSteps: () => 30,
    maxTotalTroves: maxTotal,
    ...over,
  });
  bot.botInfo = { id: 99, is_bot: true, first_name: "Guardian", username: "guardian_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      replies.push((payload as { text: string }).text);
      payloads.push(payload as Record<string, any>);
    }
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } } as never;
  });
  return bot;
}

async function say(bot: ReturnType<typeof makeBot>, text: string, chatId = 1, chatType = "private") {
  const cmd = text.split(" ")[0] ?? "";
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1, date: 0,
      chat: { id: chatId, type: chatType, first_name: "t" },
      from: { id: chatId, is_bot: false, first_name: "t" },
      text,
      entities: cmd.startsWith("/") ? [{ type: "bot_command", offset: 0, length: cmd.length }] : [],
    },
  } as never);
}

beforeEach(() => {
  store = new JsonStore(join(mkdtempSync(join(tmpdir(), "h-")), "s.json"));
  replies = [];
  payloads = [];
  rankStepsUsed = [];
  position = snap;
  maxTotal = 100;
});

describe("command handlers", () => {
  it("/track stores the address with a baseline tier", async () => {
    const bot = makeBot();
    await say(bot, `/track ${A.toLowerCase()}`);
    expect(replies[0]).toContain("Now tracking 0xa17D…aBd3");
    expect(replies[0]).toContain("safe");
    const [entry] = await store.list(1);
    expect(entry).toMatchObject({ address: A, tier: "safe", redeemZone: false });
  });

  it("/track rejects a bad address and a duplicate", async () => {
    const bot = makeBot();
    await say(bot, "/track nope");
    expect(replies[0]).toContain("valid address");
    await say(bot, `/track ${A}`);
    await say(bot, `/track ${A}`);
    expect(replies[2]).toContain("already tracking");
  });

  it("/track tells the user when there is no trove yet", async () => {
    position = null;
    const bot = makeBot();
    await say(bot, `/track ${A}`);
    expect(replies[0]).toContain("no active trove");
    expect((await store.list(1))[0]?.tier).toBeUndefined();
  });

  it("/track stops at the global capacity", async () => {
    maxTotal = 0;
    const bot = makeBot();
    await say(bot, `/track ${A}`);
    expect(replies[0]).toContain("at capacity");
    expect(await store.list(1)).toEqual([]);
  });

  it("/status includes the redemption queue when allowed and skips it at 0 steps", async () => {
    const bot = makeBot();
    await store.add(1, A);
    await say(bot, "/status");
    expect(replies[0]).toContain("Redemption queue: 185 of 255");
    expect(rankStepsUsed).toEqual([30]);

    replies = [];
    const lean = makeBot({ statusRankSteps: () => 0 });
    await say(lean, "/status");
    expect(replies[0]).not.toContain("Redemption queue");
    expect(replies[0]).toContain("Collateral ratio: 200.00%");
  });

  it("/status with nothing tracked explains how to start", async () => {
    await say(makeBot(), "/status");
    expect(replies[0]).toContain("/track");
  });

  it("/simulate uses tracked troves, or an address given in the command", async () => {
    const bot = makeBot();
    await say(bot, "/simulate 30");
    expect(replies[0]).toContain("Track an address first");
    await store.add(1, A);
    await say(bot, "/simulate 30");
    expect(replies[1]).toContain("What if BTC drops 30%?");
    expect(replies[1]).toContain("140.00%");
    await say(bot, `/simulate 30% ${A.toLowerCase()}`);
    expect(replies[2]).toContain("What if BTC drops 30%?");
  });

  it("/simulate validates its arguments", async () => {
    const bot = makeBot();
    await say(bot, "/simulate");
    await say(bot, "/simulate 0");
    await say(bot, "/simulate 100");
    await say(bot, "/simulate abc");
    await say(bot, "/simulate 30 notanaddress");
    expect(replies.slice(0, 4).every((r) => r.includes("between 1 and 99"))).toBe(true);
    expect(replies[4]).toContain("doesn't look right");
  });

  it("/alerts explains tiers and lists tracked troves", async () => {
    const bot = makeBot();
    await store.add(1, A);
    await store.setState(1, A, { tier: "watch" });
    await say(bot, "/alerts");
    expect(replies[0]).toContain("Watch: below 150.00%");
    expect(replies[0]).toContain("Liquidatable: below 110.00%");
    expect(replies[0]).toContain("0xa17D…aBd3: WATCH");
  });

  it("adds an Open dashboard Mini App button when a site address is set", async () => {
    const bot = makeBot({ siteUrl: "https://tripwire.example" });
    await store.add(1, A);
    await say(bot, "/status");
    await say(bot, "/simulate 30");
    await say(bot, `/track ${A}`.replace(A, "0x" + "2".repeat(40)));
    const button = (i: number) => payloads[i]?.reply_markup?.inline_keyboard?.[0]?.[0];
    expect(button(0)).toMatchObject({ text: "Open dashboard", web_app: { url: `https://tripwire.example/p?a=${A}` } });
    expect(button(1)?.web_app.url).toBe(`https://tripwire.example/p?a=${A}`);
    expect(button(2)?.web_app.url).toContain("/p?a=0x2222");
  });

  it("/plan opens the planner as a Mini App, or explains when there is no site", async () => {
    const bot = makeBot({ siteUrl: "https://tripwire.example" });
    await say(bot, "/plan");
    expect(payloads[0]?.reply_markup?.inline_keyboard?.[0]?.[0]).toMatchObject({ text: "Open the planner", web_app: { url: "https://tripwire.example/plan" } });
    await say(makeBot(), "/plan");
    expect(replies[1]).toContain("isn't set up");
  });

  it("sends no button when there is no site address", async () => {
    const bot = makeBot();
    await store.add(1, A);
    await say(bot, "/status");
    expect(payloads[0]?.reply_markup).toBeUndefined();
  });

  it("refuses to work in group chats", async () => {
    const bot = makeBot();
    await say(bot, `/track ${A}`, -100, "group");
    expect(replies[0]).toContain("private chats");
    expect(await store.list(-100)).toEqual([]);
    await say(bot, "just chatting", -100, "supergroup");
    expect(replies).toHaveLength(1); // no reply to non-commands in groups
  });

  it("rate-limits a chat: warns once, then stays quiet, then recovers", async () => {
    let t = 1_000_000;
    const bot = makeBot({ rateLimit: { max: 3, windowMs: 60_000 }, now: () => t });
    for (let i = 0; i < 3; i++) await say(bot, "/help");
    expect(replies).toHaveLength(3);
    await say(bot, "/help");
    expect(replies).toHaveLength(4);
    expect(replies[3]).toContain("too quickly");
    await say(bot, "/help");
    await say(bot, "/status");
    expect(replies).toHaveLength(4); // dropped silently
    await say(bot, "/help", 2); // another chat is unaffected
    expect(replies).toHaveLength(5);
    t += 61_000;
    await say(bot, "/help");
    expect(replies).toHaveLength(6); // new window
  });

  it("/untrack and /list work, and unknown text gets a hint", async () => {
    const bot = makeBot();
    await store.add(1, A);
    await say(bot, "/list");
    expect(replies[0]).toContain(A);
    await say(bot, `/untrack ${A}`);
    expect(replies[1]).toContain("Stopped tracking");
    await say(bot, "hello there");
    expect(replies[2]).toContain("/help");
  });
});
