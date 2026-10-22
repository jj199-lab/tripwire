import { Bot, type Context } from "grammy";
import type { Address } from "viem";
import { parseAddress } from "./address.js";
import { REDEMPTION_ENTER_RANK, REDEMPTION_EXIT_RANK } from "./alerts.js";
import { formatStatus, pct, shortAddress, TIER_EMOJI, TIER_LABEL } from "./format.js";
import type { PositionSnapshot, RankResult } from "./reader.js";
import { DEFAULT_TIERS } from "./risk.js";
import { formatSimulation, simulate } from "./simulate.js";
import { RateLimiter } from "./ratelimit.js";
import { MAX_TROVES_PER_CHAT, type Store } from "./storage.js";

export interface BotDeps {
  store: Store;
  readPosition: (address: Address) => Promise<PositionSnapshot | null>;
  readRank: (address: Address, maxSteps: number) => Promise<RankResult>;
  appUrl: string;
  /** Shown in /alerts. */
  pollSeconds: number;
  /** How far to scan the redemption queue for /status. 0 skips the scan (saves requests when hosted). */
  statusRankSteps: (trovesShown: number) => number;
  /** Stop accepting new addresses once this many are tracked in total. */
  maxTotalTroves: number;
  /** Messages allowed per chat per window. Defaults to 12 per minute. */
  rateLimit?: { max: number; windowMs: number };
  /** Clock for tests. */
  now?: () => number;
}

const HELP = [
  "Tripwire watches your MUSD position on Mezo testnet and messages you before it gets risky.",
  "I only read public data. I never ask for keys or seed phrases, and I can't move your funds.",
  "",
  "Commands:",
  "/track <address> - start watching a wallet's trove",
  "/status - show your tracked troves right now",
  "/simulate <drop %> - what if BTC falls by that much? (e.g. /simulate 30)",
  "/alerts - how alerts work, and your current tiers",
  "/list - show the addresses you track",
  "/untrack <address> - stop watching an address",
  "/help - show this message",
].join("\n");

export function createBot(token: string, deps: BotDeps): Bot {
  const bot = new Bot(token);
  const { store } = deps;
  const noPreview = { link_preview_options: { is_disabled: true } } as const;
  const limiter = new RateLimiter(deps.rateLimit?.max ?? 12, deps.rateLimit?.windowMs ?? 60_000, deps.now);

  // Guard for every incoming message: private chats only, and a per-chat rate limit.
  // (Proactive alerts are sent straight through the API, so they never pass through here.)
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") {
      if (ctx.message?.text?.startsWith("/")) await ctx.reply("I only work in private chats. Message me directly to track a trove.");
      return;
    }
    if (ctx.chat) {
      const verdict = limiter.check(ctx.chat.id);
      if (verdict === "warn") await ctx.reply("You're sending commands too quickly. Please wait a minute and try again.");
      if (verdict !== "ok") return;
    }
    await next();
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP));

  bot.command("track", async (ctx) => {
    const address = parseAddress(ctx.match);
    if (!address) return ctx.reply("Please send a valid address, like:\n/track 0x1234...abcd");

    if ((await store.count()) >= deps.maxTotalTroves) {
      return ctx.reply("The bot is at capacity for this test deployment, so I can't add new addresses right now.");
    }
    const result = await store.add(ctx.chat.id, address);
    if (!result.ok) {
      return ctx.reply(
        result.reason === "exists"
          ? `You're already tracking ${shortAddress(address)}.`
          : `You can track up to ${MAX_TROVES_PER_CHAT} addresses. Use /untrack to remove one first.`,
      );
    }

    try {
      const snap = await deps.readPosition(address);
      if (!snap) {
        return ctx.reply(
          `Now tracking ${shortAddress(address)}, but it has no active trove on Mezo testnet yet. I'll start reporting once it opens one.`,
        );
      }
      // Baseline: this reply tells the user the current tier, so don't alert about it again.
      await store.setState(ctx.chat.id, address, { tier: snap.tier, redeemZone: false });
      return ctx.reply(
        `Now tracking ${shortAddress(address)}.\n\n${TIER_EMOJI[snap.tier]} Current tier: ${snap.tier}. I'll message you if it changes. Send /status for details.`,
      );
    } catch (err) {
      console.error("track read failed", err);
      return ctx.reply(`Now tracking ${shortAddress(address)}. I couldn't reach Mezo testnet just now, so try /status in a minute.`);
    }
  });

  bot.command("untrack", async (ctx) => {
    const address = parseAddress(ctx.match);
    if (!address) return ctx.reply("Please send the address to stop watching, like:\n/untrack 0x1234...abcd");
    return ctx.reply((await store.remove(ctx.chat.id, address)) ? `Stopped tracking ${shortAddress(address)}.` : "That address isn't on your list.");
  });

  bot.command("list", async (ctx) => {
    const entries = await store.list(ctx.chat.id);
    if (entries.length === 0) return ctx.reply("You aren't tracking anything yet. Try /track <address>.");
    return ctx.reply(["You're tracking:", ...entries.map((e) => `• ${e.address}`)].join("\n"));
  });

  bot.command("alerts", async (ctx) => {
    const u = DEFAULT_TIERS.upper;
    const entries = await store.list(ctx.chat.id);
    const lines = [
      `How alerts work: I check about every ${deps.pollSeconds} seconds and message you when a trove changes tier or enters redemption danger.`,
      "",
      "Collateral ratio tiers:",
      `${TIER_EMOJI.watch} Watch: below ${pct(u.watch)}`,
      `${TIER_EMOJI.warning} Warning: below ${pct(u.warning)}`,
      `${TIER_EMOJI.urgent} Urgent: below ${pct(u.urgent)}`,
      `${TIER_EMOJI.liquidatable} Liquidatable: below ${pct(u.liquidatable)}`,
      `To avoid spam, I step back down a tier only once you're ${(Number(DEFAULT_TIERS.hysteresis) / 1e16).toFixed(0)} points clear of the line.`,
      "",
      `Redemption exposure: redemptions take the lowest-ratio loans first and pay debt down at $1 per MUSD. It isn't a liquidation, but you'd lose BTC exposure. I tell you when you're among the first ${REDEMPTION_ENTER_RANK} in the queue (cleared once you're beyond ${REDEMPTION_EXIT_RANK}).`,
    ];
    if (entries.length > 0) {
      lines.push("", "Your troves:");
      for (const e of entries) lines.push(`• ${shortAddress(e.address)}: ${e.tier ? TIER_LABEL[e.tier] : "no active trove yet"}`);
    }
    return ctx.reply(lines.join("\n"));
  });

  async function sendStatus(ctx: Context): Promise<void> {
    const entries = await store.list(ctx.chat!.id);
    if (entries.length === 0) {
      await ctx.reply("You aren't tracking anything yet. Try /track <address>.");
      return;
    }
    const steps = deps.statusRankSteps(entries.length);
    for (const entry of entries) {
      try {
        const snap = await deps.readPosition(entry.address);
        if (!snap) {
          await ctx.reply(`${shortAddress(entry.address)} has no active trove on Mezo testnet.`);
          continue;
        }
        const rank = steps > 0 ? await deps.readRank(entry.address, steps) : undefined;
        await ctx.reply(formatStatus(snap, rank, deps.appUrl), noPreview);
      } catch (err) {
        console.error("status read failed", err);
        await ctx.reply(`Couldn't read ${shortAddress(entry.address)} right now. Please try again in a minute.`);
      }
    }
  }
  bot.command("status", sendStatus);

  bot.command("simulate", async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const drop = Number((parts[0] ?? "").replace("%", ""));
    if (!parts[0] || !Number.isFinite(drop) || drop <= 0 || drop >= 100) {
      return ctx.reply("Tell me how far BTC falls (between 1 and 99), like:\n/simulate 30\nor for one address:\n/simulate 30 0x1234...abcd");
    }
    let targets: Address[];
    if (parts[1]) {
      const a = parseAddress(parts[1]);
      if (!a) return ctx.reply("That address doesn't look right. Example:\n/simulate 30 0x1234...abcd");
      targets = [a];
    } else {
      targets = (await store.list(ctx.chat.id)).map((e) => e.address).slice(0, MAX_TROVES_PER_CHAT);
      if (targets.length === 0) return ctx.reply("Track an address first with /track <address>, or add one: /simulate 30 0x1234...abcd");
    }
    for (const address of targets) {
      try {
        const snap = await deps.readPosition(address);
        if (!snap) {
          await ctx.reply(`${shortAddress(address)} has no active trove on Mezo testnet.`);
          continue;
        }
        await ctx.reply(formatSimulation(simulate(snap, drop), deps.appUrl), noPreview);
      } catch (err) {
        console.error("simulate read failed", err);
        await ctx.reply(`Couldn't read ${shortAddress(address)} right now. Please try again in a minute.`);
      }
    }
  });

  bot.on("message:text", (ctx) => ctx.reply("I didn't understand that. Send /help to see what I can do."));
  bot.catch((err) => console.error("Bot error:", err.error));
  return bot;
}
