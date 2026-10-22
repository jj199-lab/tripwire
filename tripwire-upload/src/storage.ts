import type { Address } from "viem";
import type { Tier } from "./risk.js";

export const MAX_TROVES_PER_CHAT = 5;

export interface TroveEntry {
  address: Address;
  /** Last tier we reported. Used to alert only on changes. */
  tier?: Tier;
  /** Whether the trove was inside the redemption danger zone at the last check. */
  redeemZone?: boolean;
  addedAt: number;
}

export interface ChatTrove extends TroveEntry {
  chatId: number;
}

export type AddResult = { ok: true } | { ok: false; reason: "limit" | "exists" };

export interface StoredState {
  tier?: Tier;
  redeemZone?: boolean;
}

/**
 * Storage sits behind an interface: a JSON file for local runs, Cloudflare D1 when hosted.
 * Everything is async so both fit.
 */
export interface Store {
  list(chatId: number): Promise<TroveEntry[]>;
  /** Every tracked trove across all chats, in a stable order, in one query. */
  listAll(): Promise<ChatTrove[]>;
  /** Total number of tracked troves across all chats. */
  count(): Promise<number>;
  add(chatId: number, address: Address): Promise<AddResult>;
  remove(chatId: number, address: Address): Promise<boolean>;
  /** Replaces the remembered alert state for one trove. */
  setState(chatId: number, address: Address, state: StoredState): Promise<void>;
  /** Forget everything for a chat, for example after the user blocks the bot. */
  removeChat(chatId: number): Promise<void>;
}
