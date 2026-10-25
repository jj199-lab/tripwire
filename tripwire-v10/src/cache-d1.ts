import type { D1Like } from "./storage-d1.js";
import { parseRaw, serializeRaw, type RawSystem } from "./system.js";
import type { CacheStore, CachedSystem } from "./viewloader.js";

export class D1Cache implements CacheStore {
  constructor(private db: D1Like) {}

  async get(): Promise<CachedSystem | null> {
    const row = await this.db
      .prepare("SELECT value, updated_at FROM system_cache WHERE key = 'snapshot'")
      .first<{ value: string; updated_at: number }>();
    if (!row) return null;
    try {
      return { raw: parseRaw(row.value), savedAt: row.updated_at };
    } catch {
      return null; // unreadable snapshot: treat as missing and rebuild it
    }
  }

  async set(raw: RawSystem, savedAt: number): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO system_cache (key, value, updated_at) VALUES ('snapshot', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .bind(serializeRaw(raw), savedAt)
      .run();
  }
}

/** Keeps one BTC price per minute so the site can chart it and estimate volatility. */
export async function recordPrice(db: D1Like, tsMs: number, priceUsd: number): Promise<void> {
  const minute = Math.floor(tsMs / 60_000) * 60_000;
  await db.prepare("INSERT OR REPLACE INTO price_history (ts, price) VALUES (?, ?)").bind(minute, priceUsd).run();
}

export async function prunePriceHistory(db: D1Like, olderThanMs: number): Promise<void> {
  await db.prepare("DELETE FROM price_history WHERE ts < ?").bind(olderThanMs).run();
}

export async function readPriceHistory(db: D1Like, sinceMs: number): Promise<Array<{ ts: number; price: number }>> {
  const { results } = await db
    .prepare("SELECT ts, price FROM price_history WHERE ts >= ? ORDER BY ts")
    .bind(sinceMs)
    .all<{ ts: number; price: number }>();
  return results;
}
