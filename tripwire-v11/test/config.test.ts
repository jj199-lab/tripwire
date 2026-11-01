import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wrangler.toml", () => {
  const text = readFileSync("wrangler.toml", "utf8");
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  it("contains only well-formed lines (a bad edit here breaks every deploy)", () => {
    for (const l of lines) expect(l, `bad line: ${l}`).toMatch(/^(\[\[?[a-z0-9_]+\]?\]|[A-Za-z_][A-Za-z0-9_]* = ("[^"\n]*"|\[.*\]|true|false|\d+))$/);
  });

  it("declares what the Worker needs", () => {
    expect(text).toMatch(/^name = "trove-guardian"$/m);
    expect(text).toMatch(/^main = "src\/worker\.ts"$/m);
    expect(text).toMatch(/^binding = "DB"$/m);
    expect(text).toMatch(/^database_name = "trove-guardian"$/m);
    expect(text).toMatch(/^crons = \["\* \* \* \* \*"\]$/m);
    expect(text).toMatch(/^BOT_USERNAME = "creationnbot"$/m);
  });

  it("holds no secrets", () => {
    expect(text).not.toMatch(/TOKEN\s*=\s*"[^"]/);
    expect(text).not.toMatch(/SECRET\s*=\s*"[^"]/);
  });
});

describe("migrations", () => {
  it("are numbered in order and only add things", () => {
    const files = readdirSync("migrations").sort();
    expect(files).toEqual(["0001_init.sql", "0002_cache.sql"]);
    for (const f of files) expect(readFileSync(`migrations/${f}`, "utf8")).not.toMatch(/DROP\s+TABLE/i);
  });
});
