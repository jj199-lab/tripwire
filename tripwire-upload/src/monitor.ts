import type { Address } from "viem";
import { decide, type AlertState } from "./alerts.js";
import { withPriceDrop } from "./demo.js";
import { shortAddress } from "./format.js";
import type { PositionSnapshot, RankResult } from "./reader.js";
import type { Store } from "./storage.js";
import type { SystemView } from "./system.js";
import type { ViewLoader } from "./viewloader.js";

export interface MonitorDeps {
  store: Store;
  readPosition: (address: Address) => Promise<PositionSnapshot | null>;
  readRank: (address: Address) => Promise<RankResult>;
  send: (chatId: number, text: string) => Promise<void>;
  appUrl: string;
  /** DEMO ONLY: pretend BTC is this many percent lower. */
  priceDropPct?: number;
  log?: (message: string, err?: unknown) => void;
  /** Check at most this many distinct addresses per pass (the Cloudflare free plan caps outgoing requests). */
  maxAddresses?: number;
  /** Rotates which addresses go first, so every address gets checked over a few passes. */
  offset?: number;
  /** Whether to check the redemption queue this pass. Default true. */
  checkRank?: boolean;
}

type Reading = { snap: PositionSnapshot | null; rank: RankResult | undefined } | "error";

/** One monitoring pass over tracked troves. Each address is read once per pass. */
export async function runOnce(deps: MonitorDeps): Promise<{ checked: number; sent: number; skipped: number }> {
  const { store, appUrl } = deps;
  const log = deps.log ?? (() => {});
  const demo = deps.priceDropPct && deps.priceDropPct > 0 ? deps.priceDropPct : 0;
  const checkRank = deps.checkRank ?? true;

  const all = await store.listAll(); // one query, whatever the number of users
  const distinct: string[] = [];
  for (const t of all) {
    const k = t.address.toLowerCase();
    if (!distinct.includes(k)) distinct.push(k);
  }
  let chosen = distinct;
  if (deps.maxAddresses !== undefined && distinct.length > deps.maxAddresses) {
    const start = distinct.length === 0 ? 0 : (deps.offset ?? 0) % distinct.length;
    chosen = [...distinct.slice(start), ...distinct.slice(0, start)].slice(0, Math.max(1, deps.maxAddresses));
  }
  const chosenSet = new Set(chosen);

  const cache = new Map<string, Reading>();
  let checked = 0;
  let sent = 0;
  let skipped = 0;

  for (const entry of all) {
    const key = entry.address.toLowerCase();
    if (!chosenSet.has(key)) {
      skipped++;
      continue;
    }
    const chatId = entry.chatId;

    let reading = cache.get(key);
    if (!reading) {
      try {
        let snap = await deps.readPosition(entry.address);
        if (snap && demo) snap = withPriceDrop(snap, demo);
        const rank = snap && checkRank ? await deps.readRank(entry.address) : undefined;
        reading = { snap, rank };
      } catch (err) {
        log(`read failed for ${entry.address}`, err);
        reading = "error";
      }
      cache.set(key, reading);
    }
    if (reading === "error") continue;
    checked++;

    const { snap, rank } = reading;
    const messages: string[] = [];
    let state: AlertState = { tier: entry.tier, redeemZone: entry.redeemZone ?? false };

    if (!snap) {
      if (entry.tier === undefined) continue; // never had a trove, nothing to say
      messages.push(
        `ℹ️ ${shortAddress(entry.address)} no longer has an active trove (it may have been closed, liquidated or fully redeemed). I'll keep watching in case it opens a new one.`,
      );
      state = {};
    } else {
      const decision = decide(state, snap, rank, appUrl);
      messages.push(...decision.messages);
      state = decision.state;
    }

    try {
      for (const m of messages) {
        await deps.send(chatId, demo ? `🧪 DEMO MODE (BTC price shifted -${demo}%)\n\n${m}` : m);
        sent++;
      }
    } catch (err) {
      log(`send failed for chat ${chatId}`, err);
      continue; // keep old state so we retry next pass
    }

    const changed = state.tier !== entry.tier || (state.redeemZone ?? false) !== (entry.redeemZone ?? false);
    if (changed) await store.setState(chatId, entry.address, state);
  }
  return { checked, sent, skipped };
}

export interface PassOptions {
  store: Store;
  loader: ViewLoader;
  send: MonitorDeps["send"];
  appUrl: string;
  priceDropPct?: number;
  /** Re-read every trove this pass instead of topping up the saved snapshot. */
  forceFull?: boolean;
  /** Called with the fresh view, for example to record the price. */
  onView?: (view: SystemView) => Promise<void> | void;
  log?: MonitorDeps["log"];
}

/**
 * One full monitoring pass: load a fresh picture of the protocol (a handful of requests whatever the number
 * of tracked addresses), then check every tracked trove against it in memory.
 */
export async function runMonitorPass(o: PassOptions): Promise<{ checked: number; sent: number; skipped: number }> {
  const all = await o.store.listAll();
  const addresses = [...new Set(all.map((t) => t.address.toLowerCase()))];
  const view = await o.loader.load(addresses, { forceFull: o.forceFull });
  await o.onView?.(view);
  return runOnce({
    store: o.store,
    readPosition: async (a) => view.position(a),
    readRank: async (a) => view.rank(a),
    send: o.send,
    appUrl: o.appUrl,
    priceDropPct: o.priceDropPct,
    log: o.log,
  });
}
