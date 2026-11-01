import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { D1Like } from "../../src/storage-d1.js";

// Runs the real D1 SQL against SQLite (node:sqlite) through a tiny D1-shaped adapter.
// Tests using it are skipped on Node versions without node:sqlite.
let DatabaseSync: (new (path: string) => any) | undefined;
try {
  DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = undefined;
}
export const hasSqlite = DatabaseSync !== undefined;

export function fakeD1(): D1Like {
  const db = new DatabaseSync!(":memory:");
  for (const f of ["0001_init.sql", "0002_cache.sql"]) db.exec(readFileSync(`migrations/${f}`, "utf8"));
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...v: unknown[]) {
          args = v;
          return stmt;
        },
        async run() {
          const r = db.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes) } };
        },
        async first() {
          return db.prepare(sql).get(...args) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...args) };
        },
      };
      return stmt as any;
    },
  };
}
