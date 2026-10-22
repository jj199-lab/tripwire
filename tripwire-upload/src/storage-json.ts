import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "viem";
import { MAX_TROVES_PER_CHAT, type AddResult, type ChatTrove, type Store, type StoredState, type TroveEntry } from "./storage.js";

type Data = Record<string, TroveEntry[]>;

/** Local-development store. Not used by the Cloudflare Worker (it needs node:fs). */
export class JsonStore implements Store {
  private data: Data = {};

  constructor(private path: string) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8")) as Data;
      } catch {
        // Corrupt file: start fresh rather than crash the bot.
        this.data = {};
      }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  async list(chatId: number): Promise<TroveEntry[]> {
    return [...(this.data[String(chatId)] ?? [])];
  }

  async listAll(): Promise<ChatTrove[]> {
    const out: ChatTrove[] = [];
    for (const [chat, entries] of Object.entries(this.data)) {
      for (const e of entries) out.push({ ...e, chatId: Number(chat) });
    }
    return out.sort((a, b) => a.addedAt - b.addedAt || a.chatId - b.chatId);
  }

  async count(): Promise<number> {
    return Object.values(this.data).reduce((n, entries) => n + entries.length, 0);
  }

  async add(chatId: number, address: Address): Promise<AddResult> {
    const key = String(chatId);
    const entries = this.data[key] ?? [];
    if (entries.some((e) => e.address.toLowerCase() === address.toLowerCase())) return { ok: false, reason: "exists" };
    if (entries.length >= MAX_TROVES_PER_CHAT) return { ok: false, reason: "limit" };
    this.data[key] = [...entries, { address, addedAt: Date.now() }];
    this.save();
    return { ok: true };
  }

  async remove(chatId: number, address: Address): Promise<boolean> {
    const key = String(chatId);
    const entries = this.data[key] ?? [];
    const next = entries.filter((e) => e.address.toLowerCase() !== address.toLowerCase());
    if (next.length === entries.length) return false;
    if (next.length === 0) delete this.data[key];
    else this.data[key] = next;
    this.save();
    return true;
  }

  async setState(chatId: number, address: Address, state: StoredState): Promise<void> {
    const entry = this.data[String(chatId)]?.find((e) => e.address.toLowerCase() === address.toLowerCase());
    if (!entry) return;
    entry.tier = state.tier;
    entry.redeemZone = state.redeemZone;
    this.save();
  }

  async removeChat(chatId: number): Promise<void> {
    if (!(String(chatId) in this.data)) return;
    delete this.data[String(chatId)];
    this.save();
  }
}
