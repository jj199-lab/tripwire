import type { PublicClient } from "viem";
import type { Deployment } from "./config.js";
import { buildView, readFresh, readSystem, type RawSystem, type SystemView } from "./system.js";

export interface CachedSystem {
  raw: RawSystem;
  savedAt: number;
}

/** Where the last full read is kept between runs: memory locally, Cloudflare D1 when hosted. */
export interface CacheStore {
  get(): Promise<CachedSystem | null>;
  set(raw: RawSystem, savedAt: number): Promise<void>;
}

export class MemoryCache implements CacheStore {
  private value: CachedSystem | null = null;
  async get(): Promise<CachedSystem | null> {
    return this.value;
  }
  async set(raw: RawSystem, savedAt: number): Promise<void> {
    this.value = { raw, savedAt };
  }
}

/** A full read of every trove is the expensive one, so do it every few minutes and top up in between. */
export const FULL_REFRESH_MS = 5 * 60_000;

export class ViewLoader {
  constructor(
    private opts: {
      client: PublicClient;
      deployment: Deployment;
      cache: CacheStore;
      now?: () => number;
      fullRefreshMs?: number;
    },
  ) {}

  /**
   * A consistent picture of the protocol. Usually: the saved snapshot plus one small request that
   * refreshes the price and the given addresses. Every few minutes, or on demand: a full re-read.
   */
  async load(addresses: string[], o: { forceFull?: boolean } = {}): Promise<SystemView> {
    const { client, deployment, cache } = this.opts;
    const now = (this.opts.now ?? Date.now)();
    const cached = await cache.get();
    const stale = !cached || o.forceFull || now - cached.savedAt >= (this.opts.fullRefreshMs ?? FULL_REFRESH_MS);

    if (stale) {
      try {
        const raw = await readSystem(client, deployment, now);
        await cache.set(raw, now);
        return buildView(raw, { snapshotAt: now });
      } catch (err) {
        if (!cached) throw err; // nothing to fall back on
        console.error("full refresh failed, using the saved snapshot:", err instanceof Error ? err.message : err);
      }
    }
    const { price, rows } = await readFresh(client, deployment, addresses);
    return buildView(cached!.raw, { price, overrides: rows, snapshotAt: cached!.savedAt });
  }
}

/** Remembers recent views for a few seconds, so one chat command doesn't trigger several identical reads. */
export class ViewCache {
  private entries = new Map<string, { at: number; view: Promise<SystemView> }>();

  constructor(
    private load: (addresses: string[]) => Promise<SystemView>,
    private ttlMs = 20_000,
    private now: () => number = Date.now,
  ) {}

  get(addresses: string[]): Promise<SystemView> {
    const key = [...new Set(addresses.map((a) => a.toLowerCase()))].sort().join(",");
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && t - hit.at < this.ttlMs) return hit.view;
    if (this.entries.size > 50) for (const [k, e] of this.entries) if (t - e.at >= this.ttlMs) this.entries.delete(k);
    const view = this.load(addresses);
    this.entries.set(key, { at: t, view });
    view.catch(() => this.entries.delete(key));
    return view;
  }

  /** Adapters in the shape the command handlers and the monitor expect. */
  readers() {
    return {
      readPosition: async (a: string) => (await this.get([a])).position(a),
      readRank: async (a: string) => (await this.get([a])).rank(a),
    };
  }
}
