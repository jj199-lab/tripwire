// Cloudflare Worker entry: Telegram webhook, public JSON API, landing page, and a once-a-minute monitor.
import { Api, GrammyError, webhookCallback, type Bot } from "grammy";
import { formatUnits } from "viem";
import { parseAddress } from "./address.js";
import { planSummary, positionSummary, systemSummary } from "./api.js";
import { D1Cache, prunePriceHistory, readPriceHistory, recordPrice } from "./cache-d1.js";
import { APP_URL } from "./config.js";
import { createBot, type BotDeps } from "./handlers.js";
import { landingResponse } from "./landing.js";
import { planPageResponse, planScriptResponse } from "./pages/plan.js";
import { positionPageResponse, positionScriptResponse } from "./pages/position.js";
import { runMonitorPass } from "./monitor.js";
import { RateLimiter } from "./ratelimit.js";
import { makeClient } from "./reader.js";
import { D1Store, type D1Like } from "./storage-d1.js";
import { buildView } from "./system.js";
import { ViewCache, ViewLoader } from "./viewloader.js";

export interface Env {
  DB: D1Database;
  /** Secret: set with `npx wrangler secret put TELEGRAM_BOT_TOKEN`. */
  TELEGRAM_BOT_TOKEN: string;
  /** Secret: random string Telegram sends back with every webhook call. */
  WEBHOOK_SECRET: string;
  MATSNET_RPC_URL?: string;
  /** DEMO ONLY. Leave blank. */
  DEMO_PRICE_DROP_PCT?: string;
  /** Telegram username (no @) shown on the landing page. */
  BOT_USERNAME?: string;
  /** Public GitHub link shown on the landing page. Leave blank until the repo exists. */
  REPO_URL?: string;
  /** Public address of this Worker, used for dashboard links and the Telegram Mini App button. */
  SITE_URL?: string;
  MAX_TOTAL_TROVES?: string;
}

const db = (env: Env): D1Like => env.DB as unknown as D1Like;

function loaderFor(env: Env): ViewLoader {
  const { client, deployment } = makeClient("matsnet", { rpcUrl: env.MATSNET_RPC_URL || undefined });
  return new ViewLoader({ client, deployment, cache: new D1Cache(db(env)) });
}

// Reused between requests in the same isolate.
let shared: { views: ViewCache; loader: ViewLoader } | undefined;
function sharedFor(env: Env) {
  if (!shared) {
    const loader = loaderFor(env);
    shared = { loader, views: new ViewCache((a) => loader.load(a)) };
  }
  return shared;
}

function botDeps(env: Env): BotDeps {
  const readers = sharedFor(env).views.readers();
  return {
    store: new D1Store(db(env)),
    readPosition: readers.readPosition,
    readRank: (a) => readers.readRank(a),
    appUrl: APP_URL,
    siteUrl: env.SITE_URL || undefined,
    pollSeconds: 60,
    statusRankSteps: () => 1,
    maxTotalTroves: Number(env.MAX_TOTAL_TROVES) || 100,
  };
}

type Handler = (request: Request) => Promise<Response>;
let cachedHandler: { key: string; handler: Handler } | undefined;
function getHandler(env: Env): Handler {
  // Reuse the bot and its webhook handler between requests in the same isolate,
  // so we don't call Telegram's getMe on every message.
  const key = `${env.TELEGRAM_BOT_TOKEN}:${env.WEBHOOK_SECRET}`;
  if (!cachedHandler || cachedHandler.key !== key) {
    const bot: Bot = createBot(env.TELEGRAM_BOT_TOKEN, botDeps(env));
    cachedHandler = { key, handler: webhookCallback(bot, "cloudflare-mod", { secretToken: env.WEBHOOK_SECRET }) as Handler };
  }
  return cachedHandler.handler;
}

/** Constant-time string comparison, so response timing can't leak the secret. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status = 200, cache = "no-store"): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff" },
  });

const ipHash = (ip: string): number => {
  let h = 0;
  for (let i = 0; i < ip.length; i++) h = (Math.imul(31, h) + ip.charCodeAt(i)) | 0;
  return h;
};
const apiLimiter = new RateLimiter(30, 60_000);
const wad = (usd: number): bigint => BigInt(Math.round(usd * 100)) * 10n ** 16n;

/** The saved snapshot with the freshest recorded price on top. Null until the first full read has happened. */
async function cachedView(env: Env) {
  const cached = await new D1Cache(db(env)).get();
  if (!cached) return null;
  const recent = await readPriceHistory(db(env), Date.now() - 10 * 60_000);
  const last = recent[recent.length - 1];
  return buildView(cached.raw, { price: last ? wad(last.price) : undefined, snapshotAt: cached.savedAt });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const verdict = apiLimiter.check(ipHash(request.headers.get("CF-Connecting-IP") ?? "unknown"));
  if (verdict !== "ok") return json({ error: "Too many requests. Please slow down." }, 429);

  if (url.pathname === "/api/system") {
    const view = await cachedView(env);
    if (!view) return json({ error: "Warming up. Try again in a minute." }, 503);
    return json(systemSummary(view, Date.now()), 200, "public, max-age=30");
  }

  if (url.pathname === "/api/plan") {
    const view = await cachedView(env);
    if (!view) return json({ error: "Warming up. Try again in a minute." }, 503);
    return json(planSummary(view, Date.now()), 200, "public, max-age=30");
  }

  if (url.pathname === "/api/position") {
    const address = parseAddress(url.searchParams.get("address") ?? "");
    if (!address) return json({ error: "That doesn't look like a valid address." }, 400);
    try {
      const view = await sharedFor(env).views.get([address]);
      return json(positionSummary(view.position(address), view.rank(address), view, address), 200, "public, max-age=15");
    } catch (err) {
      console.error("position api failed", err instanceof Error ? err.message : err);
      return json({ error: "Couldn't read the chain just now. Try again in a minute." }, 502);
    }
  }

  if (url.pathname === "/api/prices") {
    const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours")) || 24));
    const rows = await readPriceHistory(db(env), Date.now() - hours * 3_600_000);
    return json({ hours, points: rows.map((r) => [r.ts, r.price]) }, 200, "public, max-age=60");
  }

  return json({ error: "Not found" }, 404);
}

export async function monitorPass(env: Env, scheduledTime: number): Promise<void> {
  const database = db(env);
  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  const demo = Number(env.DEMO_PRICE_DROP_PCT) || 0;
  const minute = Math.floor(scheduledTime / 60_000);

  try {
    await monitorOnce(env, database, api, demo, minute, scheduledTime);
  } catch (err) {
    // An RPC or database hiccup should show up as a logged error, not as a crashed run.
    console.error("monitor pass failed:", err instanceof Error ? err.message : err);
  }
}

async function monitorOnce(env: Env, database: D1Like, api: Api, demo: number, minute: number, scheduledTime: number): Promise<void> {
  const result = await runMonitorPass({
    store: new D1Store(database),
    loader: loaderFor(env),
    send: async (chatId, text) => {
      try {
        await api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 403) {
          await new D1Store(database).removeChat(chatId); // user blocked the bot
          return;
        }
        throw err;
      }
    },
    appUrl: APP_URL,
    siteUrl: env.SITE_URL || undefined,
    priceDropPct: demo > 0 && demo < 100 ? demo : undefined,
    onView: async (view) => {
      await recordPrice(database, scheduledTime, Number(formatUnits(view.price, 18)));
      if (minute % 60 === 0) await prunePriceHistory(database, scheduledTime - 30 * 24 * 3_600_000);
    },
    log: (m, e) => console.error(m, e instanceof Error ? e.message : (e ?? "")),
  });
  if (result.sent > 0) console.log(`monitor: checked ${result.checked}, sent ${result.sent}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhook") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.WEBHOOK_SECRET) return new Response("Not configured", { status: 500 });
      // Reject forged requests before doing any work or making any outgoing call.
      const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (!safeEqual(header, env.WEBHOOK_SECRET)) return new Response("Unauthorized", { status: 401 });
      return getHandler(env)(request);
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
      return landingResponse({ botUsername: env.BOT_USERNAME, repoUrl: env.REPO_URL, appUrl: APP_URL });
    }
    if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/p" || url.pathname === "/p/")) {
      return positionPageResponse({ appUrl: APP_URL, botUsername: env.BOT_USERNAME });
    }
    if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/plan" || url.pathname === "/plan/")) {
      return planPageResponse({ appUrl: APP_URL, botUsername: env.BOT_USERNAME });
    }
    if (request.method === "GET" && url.pathname === "/assets/position.js") return positionScriptResponse();
    if (request.method === "GET" && url.pathname === "/assets/plan.js") return planScriptResponse();
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(monitorPass(env, controller.scheduledTime));
  },
};
