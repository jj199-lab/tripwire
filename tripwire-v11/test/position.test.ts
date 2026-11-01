import { runInNewContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { POSITION_HEADERS, POSITION_JS, SCRIPT_HEADERS, positionPageResponse, positionScriptResponse, renderPositionPage } from "../src/pages/position.js";

// Run the exact script that ships to the browser, in a context with no DOM, to reach its pure maths.
const sandbox: Record<string, any> = {};
runInNewContext(POSITION_JS, sandbox);
const tw = sandbox.__tripwire as {
  tierFor(r: number, t: any): string;
  whatIf(p: any, drop: number, target: number): any;
  dropToLiquidation(p: any): number;
  usd(n: number): string; btc(n: number): string; musd(n: number): string; pct(n: number): string; shorten(a: string): string;
};

const tiers = { liquidationBelowPct: 110, urgentBelowPct: 120, warningBelowPct: 135, watchBelowPct: 150 };
// 0.05 BTC at $80,000 backing 2,000 MUSD: ratio 200%, liquidation at $44,000.
const pos = { btcPrice: 80_000, collateralBtc: 0.05, debtMusd: 2_000, ratioPct: 200, liquidationPrice: 44_000, tiers };

describe("the browser script", () => {
  it("compiles, and does not touch the page when there is none", () => {
    expect(() => new Script(POSITION_JS)).not.toThrow();
    expect(tw).toBeTruthy();
  });

  it("assigns tiers at the same lines the bot uses", () => {
    expect(["109.99", "110", "119.9", "120", "134.9", "135", "149.9", "150"].map((r) => tw.tierFor(Number(r), tiers))).toEqual([
      "liquidatable", "urgent", "urgent", "warning", "warning", "watch", "watch", "safe",
    ]);
  });

  it("works out a 30% fall: ratio 140%, watch tier", () => {
    const w = tw.whatIf(pos, 30, 150);
    expect(w.price).toBeCloseTo(56_000, 6);
    expect(w.ratio).toBeCloseTo(140, 6);
    expect(w.tier).toBe("watch");
    expect(w.liquidatable).toBe(false);
  });

  it("says how much to add or repay to get back to a target, and both actually work", () => {
    const w = tw.whatIf(pos, 30, 150);
    expect(w.addBtc).toBeCloseTo((1.5 * 2000) / 56_000 - 0.05, 9);
    expect(w.repayMusd).toBeCloseTo(2000 - (0.05 * 56_000) / 1.5, 9);
    expect(((0.05 + w.addBtc) * w.price) / 2000).toBeCloseTo(1.5, 9);
    expect((0.05 * w.price) / (2000 - w.repayMusd)).toBeCloseTo(1.5, 9);
  });

  it("needs nothing when already above the target, and flags liquidation", () => {
    expect(tw.whatIf(pos, 10, 150)).toMatchObject({ addBtc: 0, repayMusd: 0, tier: "safe" });
    const crash = tw.whatIf(pos, 50, 150);
    expect(crash.liquidatable).toBe(true);
    expect(crash.tier).toBe("liquidatable");
  });

  it("matches the server's simulate maths for the same inputs", async () => {
    const { simulate } = await import("../src/simulate.js");
    const { WAD } = await import("../src/risk.js");
    const snap = { borrower: "0x" + "1".repeat(40), price: 80_000n * WAD, coll: (5n * WAD) / 100n, debt: 2_000n * WAD } as any;
    const server = simulate({ ...snap, icr: 0n, icrLocal: 0n, liqPrice: 0n, dropBps: 0, tier: "safe", tcr: 0n, recoveryMode: false }, 30);
    const client = tw.whatIf(pos, 30, 150);
    expect(Number(server.after.icr) / 1e16).toBeCloseTo(client.ratio, 4);
    expect(Number(server.addCollateral) / 1e18).toBeCloseTo(client.addBtc, 6);
    expect(Number(server.repayDebt) / 1e18).toBeCloseTo(client.repayMusd, 4);
  });

  it("measures the fall to liquidation, and copes with a zero-debt loan", () => {
    expect(tw.dropToLiquidation(pos)).toBeCloseTo(45, 6);
    expect(tw.dropToLiquidation({ ...pos, liquidationPrice: 90_000 })).toBe(0);
    const none = tw.whatIf({ ...pos, debtMusd: 0 }, 30, 150);
    expect(none.addBtc).toBe(0);
    expect(tw.pct(none.ratio)).toBe("no debt");
  });

  it("formats numbers for people", () => {
    expect(tw.usd(81_378.686)).toBe("$81,378.69");
    expect(tw.btc(0.05)).toBe("0.05 BTC");
    expect(tw.musd(2202)).toBe("2,202.00 MUSD");
    expect(tw.pct(110.874)).toBe("110.87%");
    expect(tw.shorten("0xa17DE314e60b455766D030b7CFfE178d912caBd3")).toBe("0xa17D\u2026aBd3");
  });

  it("only writes API values into the page as text, never as HTML", () => {
    expect(POSITION_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });
});

describe("the dashboard page", () => {
  const html = renderPositionPage({ appUrl: "https://testnet.mezo.org/borrow", botUsername: "creationnbot" });

  it("has what a visitor needs", () => {
    expect(html).toContain('aria-label="Wallet address"');
    expect(html).toContain('type="range"');
    expect(html).toContain('data-target="150" aria-pressed="true"');
    expect(html).toContain('href="https://testnet.mezo.org/borrow"');
    expect(html).toContain('href="https://t.me/creationnbot"');
    expect(html).toContain('<script src="/assets/position.js"></script>');
  });

  it("has no inline scripts or remote resources, so a strict policy works", () => {
    expect(html).not.toMatch(/<script(?![^>]*src=)/i);
    expect(html).not.toMatch(/\son[a-z]+="/i);
    expect(html).not.toMatch(/src="https?:/i);
    const csp = POSITION_HEADERS["content-security-policy"]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors https://web.telegram.org");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("leaves out the bot link when the username is unsafe", () => {
    expect(renderPositionPage({ appUrl: "x", botUsername: 'a"><b' })).not.toContain("t.me/");
  });

  it("serves the page and the script with the right headers", async () => {
    const page = positionPageResponse({ appUrl: "x" });
    expect(page.headers.get("content-type")).toContain("text/html");
    const js = positionScriptResponse();
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await js.text()).toBe(POSITION_JS);
    expect(SCRIPT_HEADERS["cache-control"]).toContain("max-age");
  });
});
