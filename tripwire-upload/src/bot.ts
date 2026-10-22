// Local runner: long polling + a timer. For the hosted version see src/worker.ts.
import { GrammyError } from "grammy";
import { APP_URL, type NetworkName } from "./config.js";
import { createBot } from "./handlers.js";
import { runMonitorPass } from "./monitor.js";
import { makeClient } from "./reader.js";
import { JsonStore } from "./storage-json.js";
import { MemoryCache, ViewCache, ViewLoader } from "./viewloader.js";

const NETWORK: NetworkName = "matsnet";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and paste your token from @BotFather.");
  process.exit(1);
}

const pollSeconds = Math.max(15, Number(process.env.POLL_SECONDS ?? 60) || 60);
const demoDrop = Number(process.env.DEMO_PRICE_DROP_PCT ?? 0) || 0;
if (demoDrop < 0 || demoDrop >= 100) {
  console.error("DEMO_PRICE_DROP_PCT must be between 0 and 99.");
  process.exit(1);
}

const store = new JsonStore(process.env.STORE_PATH ?? "data/store.json");
const { client, deployment } = makeClient(NETWORK, { rpcUrl: process.env.MATSNET_RPC_URL || undefined });
const loader = new ViewLoader({ client, deployment, cache: new MemoryCache() });
const readers = new ViewCache((a) => loader.load(a)).readers();

const bot = createBot(token, {
  store,
  readPosition: readers.readPosition,
  readRank: (a) => readers.readRank(a),
  appUrl: APP_URL,
  pollSeconds,
  statusRankSteps: () => 1,
  maxTotalTroves: 1000,
});

/** Sends a proactive message. If the user blocked the bot, forget their chat instead of retrying forever. */
async function send(chatId: number, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 403) {
      console.log(`Chat ${chatId} blocked the bot, removing their tracked troves.`);
      await store.removeChat(chatId);
      return;
    }
    throw err;
  }
}

let running = false;
async function monitorTick(): Promise<void> {
  if (running) return; // never overlap passes if the RPC is slow
  running = true;
  try {
    const { checked, sent } = await runMonitorPass({
      store,
      loader,
      send,
      appUrl: APP_URL,
      priceDropPct: demoDrop || undefined,
      log: (m, e) => console.error(m, e ?? ""),
    });
    if (sent > 0) console.log(`Monitor: checked ${checked}, sent ${sent} message(s).`);
  } catch (err) {
    console.error("Monitor pass failed", err);
  } finally {
    running = false;
  }
}

console.log("Tripwire starting on", NETWORK, "...");
if (demoDrop) console.log(`*** DEMO MODE: alerts will simulate a ${demoDrop}% BTC price drop and say so. ***`);
bot.start({
  onStart: (me) => {
    console.log(`Running as @${me.username}. Checking every ${pollSeconds}s. Press Ctrl+C to stop.`);
    setTimeout(monitorTick, 5_000);
    setInterval(monitorTick, pollSeconds * 1_000);
  },
});
