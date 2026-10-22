import type { Address } from "viem";
import type { Tier } from "./risk.js";
import { MAX_TROVES_PER_CHAT, type AddResult, type ChatTrove, type Store, type StoredState, type TroveEntry } from "./storage.js";

/** The small part of Cloudflare's D1 API we use, so tests can fake it. */
export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}
export interface D1Like {
  prepare(sql: string): D1PreparedLike;
}

interface Row {
  chat_id: number;
  address: string;
  tier: string | null;
  redeem_zone: number;
  added_at: number;
}

const toEntry = (r: Row): ChatTrove => ({
  chatId: r.chat_id,
  address: r.address as Address,
  tier: (r.tier ?? undefined) as Tier | undefined,
  redeemZone: r.redeem_zone === 1,
  addedAt: r.added_at,
});

export class D1Store implements Store {
  constructor(private db: D1Like) {}

  async list(chatId: number): Promise<TroveEntry[]> {
    const { results } = await this.db
      .prepare("SELECT chat_id, address, tier, redeem_zone, added_at FROM troves WHERE chat_id = ? ORDER BY added_at, addr_lc")
      .bind(chatId)
      .all<Row>();
    return results.map(toEntry);
  }

  async listAll(): Promise<ChatTrove[]> {
    const { results } = await this.db
      .prepare("SELECT chat_id, address, tier, redeem_zone, added_at FROM troves ORDER BY added_at, chat_id, addr_lc")
      .all<Row>();
    return results.map(toEntry);
  }

  async count(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS c FROM troves").first<{ c: number }>();
    return row?.c ?? 0;
  }

  async add(chatId: number, address: Address): Promise<AddResult> {
    const lc = address.toLowerCase();
    const exists = await this.db.prepare("SELECT 1 AS x FROM troves WHERE chat_id = ? AND addr_lc = ?").bind(chatId, lc).first();
    if (exists) return { ok: false, reason: "exists" };
    const row = await this.db.prepare("SELECT COUNT(*) AS c FROM troves WHERE chat_id = ?").bind(chatId).first<{ c: number }>();
    if ((row?.c ?? 0) >= MAX_TROVES_PER_CHAT) return { ok: false, reason: "limit" };
    await this.db
      .prepare("INSERT OR IGNORE INTO troves (chat_id, addr_lc, address, tier, redeem_zone, added_at) VALUES (?, ?, ?, NULL, 0, ?)")
      .bind(chatId, lc, address, Date.now())
      .run();
    return { ok: true };
  }

  async remove(chatId: number, address: Address): Promise<boolean> {
    const res = await this.db.prepare("DELETE FROM troves WHERE chat_id = ? AND addr_lc = ?").bind(chatId, address.toLowerCase()).run();
    return (res.meta?.changes ?? 0) > 0;
  }

  async setState(chatId: number, address: Address, state: StoredState): Promise<void> {
    await this.db
      .prepare("UPDATE troves SET tier = ?, redeem_zone = ? WHERE chat_id = ? AND addr_lc = ?")
      .bind(state.tier ?? null, state.redeemZone ? 1 : 0, chatId, address.toLowerCase())
      .run();
  }

  async removeChat(chatId: number): Promise<void> {
    await this.db.prepare("DELETE FROM troves WHERE chat_id = ?").bind(chatId).run();
  }
}
