import { runInNewContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { PLAN_HEADERS, PLAN_JS, planPageResponse, planScriptResponse, renderPlanPage } from "../src/pages/plan.js";

// Run the exact script that ships to the browser, in a context with no DOM, to reach its pure maths.
const sandbox: Record<string, any> = {};
runInNewContext(PLAN_JS, sandbox);
const pl = sandbox.__plan as {
  normCdf(x: number): number;
  liquidationChance(ratio: number, liq: number, sigma: number, days: number): number;
  grade(p: number): string;
  queuePosition(q: Array<[number, number]>, ratio: number): { rank: number; size: number; musdAhead: number };
  plan(btc: number, ratio: number, t: any): any;
  parseBtc(s: string): number;
  chanceText(p: number): string;
  usd(n: number): string; musd(n: number): string;
};

// Mezo's defaults: 0.1% fee, 1,800 MUSD minimum, 200 MUSD gas deposit, 1% interest, 110% liquidation, 150% recovery.
const terms = (over: Record<string, unknown> = {}) => ({
  price: 80_000, recovery: false, feePct: 0.1, minLoan: 1_800, gas: 200, interestPct: 1, liqPct: 110, ccrPct: 150,
  totalColl: 100, totalDebt: 4_000_000, queue: [] as Array<[number, number]>, ...over,
});

describe("the planner script", () => {
  it("compiles, and leaves the page alone when there is none", () => {
    expect(() => new Script(PLAN_JS)).not.toThrow();
    expect(pl).toBeTruthy();
  });

  it("computes the normal distribution accurately", () => {
    expect(pl.normCdf(0)).toBeCloseTo(0.5, 6);
    expect(pl.normCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(pl.normCdf(-1)).toBeCloseTo(0.1586553, 6);
    expect(pl.normCdf(3)).toBeCloseTo(0.9986501, 6);
    expect(pl.normCdf(-8)).toBeLessThan(1e-9);
  });

  describe("chance of liquidation", () => {
    it("matches the textbook value when the buffer equals one standard deviation", () => {
      const s = 0.6 * Math.sqrt(30 / 365);
      expect(pl.liquidationChance(110 * Math.exp(s), 110, 0.6, 30)).toBeCloseTo(0.3173105, 5);
    });

    it("gives hand-checked numbers for a typical month", () => {
      expect(pl.liquidationChance(160, 110, 0.6, 30)).toBeCloseTo(0.0294, 3);
      expect(pl.liquidationChance(200, 110, 0.6, 30)).toBeLessThan(0.002);
      expect(pl.liquidationChance(130, 110, 0.6, 30)).toBeGreaterThan(0.3);
    });

    it("rises with volatility and time, falls with caution, and is certain at or below the line", () => {
      const base = pl.liquidationChance(160, 110, 0.6, 30);
      expect(pl.liquidationChance(160, 110, 0.9, 30)).toBeGreaterThan(base);
      expect(pl.liquidationChance(160, 110, 0.6, 90)).toBeGreaterThan(base);
      expect(pl.liquidationChance(180, 110, 0.6, 30)).toBeLessThan(base);
      expect(pl.liquidationChance(110, 110, 0.6, 30)).toBe(1);
      expect(pl.liquidationChance(100, 110, 0.6, 30)).toBe(1);
    });

    it("never goes above 100%", () => {
      expect(pl.liquidationChance(111, 110, 3, 365)).toBeLessThanOrEqual(1);
    });

    it("grades and words the result", () => {
      expect(["0.005", "0.03", "0.1", "0.2", "0.5"].map((p) => pl.grade(Number(p)))).toEqual(["Very low", "Low", "Moderate", "High", "Very high"]);
      expect(pl.chanceText(0.0004)).toBe("under 0.1%");
      expect(pl.chanceText(0.0294)).toBe("2.9%");
      expect(pl.chanceText(0.3173)).toBe("32%");
      expect(pl.chanceText(0.995)).toBe("over 99%");
    });
  });

  describe("the loan maths, following Mezo's openTrove", () => {
    const r = pl.plan(0.05, 160, terms());

    it("works out the debt, what you receive, the fee and the gas deposit", () => {
      expect(r.debt).toBeCloseTo(2_500, 6); // 0.05 BTC x $80,000 / 1.6
      expect(r.receive).toBeCloseTo(2_300 / 1.001, 6); // debt - 200 gas deposit, then take off the 0.1% fee
      expect(r.fee).toBeCloseTo(2_300 - 2_300 / 1.001, 6);
      expect(r.receive + r.fee + 200).toBeCloseTo(r.debt, 6); // everything adds back up to the debt
    });

    it("works out the liquidation price, the fall to it and a year of interest", () => {
      expect(r.liqPrice).toBeCloseTo(55_000, 6);
      expect(r.fallPct).toBeCloseTo(31.25, 6);
      expect(r.interestYear).toBeCloseTo(25, 6);
    });

    it("allows a normal loan", () => {
      expect(r).toMatchObject({ ratioTooLow: false, belowMinimum: false, blockedBySystem: false, requiredRatio: 110 });
      expect(r.newTcr).toBeCloseTo((100.05 * 80_000) / 4_002_500 * 100, 6);
    });

    it("charges no fee in Recovery Mode, and then needs 150%", () => {
      const rm = pl.plan(0.05, 130, terms({ recovery: true }));
      expect(rm.fee).toBe(0);
      expect(rm.requiredRatio).toBe(150);
      expect(rm.ratioTooLow).toBe(true);
      expect(pl.plan(0.05, 160, terms({ recovery: true })).receive).toBeCloseTo(2_300, 6);
      expect(pl.plan(0.05, 160, terms({ recovery: true })).ratioTooLow).toBe(false);
    });

    it("refuses a ratio under the 110% line", () => {
      expect(pl.plan(0.05, 105, terms()).ratioTooLow).toBe(true);
      expect(pl.plan(0.05, 110, terms()).ratioTooLow).toBe(false);
    });

    it("flags a loan under the minimum, and says how much BTC would fix it", () => {
      const small = pl.plan(0.03, 160, terms()); // debt 1,500 -> 1,300 after the gas deposit
      expect(small.belowMinimum).toBe(true);
      expect(small.minBtc).toBeCloseTo(0.04, 9); // (1,800 + 200) x 1.6 / 80,000
      const fixed = pl.plan(small.minBtc, 160, terms());
      expect(fixed.belowMinimum).toBe(false);
    });

    it("applies the minimum to the amount plus the fee, as the contract does", () => {
      // A loan whose debt after the gas deposit is exactly the minimum is allowed.
      const exact = pl.plan(0.04, 160, terms()); // debt 2,000 -> 1,800
      expect(exact.belowMinimum).toBe(false);
    });

    it("rejects a loan that would push the whole system under 150%", () => {
      const tight = terms({ totalColl: 100, totalDebt: 5_330_000 }); // system at about 150.09%
      const big = pl.plan(1, 110, tight);
      expect(big.newTcr).toBeLessThan(150);
      expect(big.blockedBySystem).toBe(true);
      expect(pl.plan(0.05, 200, tight).blockedBySystem).toBe(false); // a small, cautious loan is fine
      expect(pl.plan(1, 110, { ...tight, recovery: true }).blockedBySystem).toBe(false); // the system rule is for normal mode
    });
  });

  describe("place in the redemption queue", () => {
    const q: Array<[number, number]> = [[110, 100], [120, 200], [150, 300]];
    it("counts the loans below you and the MUSD that must go first", () => {
      expect(pl.queuePosition(q, 130)).toEqual({ rank: 3, size: 4, musdAhead: 300 });
      expect(pl.queuePosition(q, 100)).toEqual({ rank: 1, size: 4, musdAhead: 0 });
      expect(pl.queuePosition(q, 200)).toEqual({ rank: 4, size: 4, musdAhead: 600 });
      expect(pl.queuePosition(q, 120)).toEqual({ rank: 2, size: 4, musdAhead: 100 }); // equal ratios are not ahead
      expect(pl.queuePosition([], 160)).toEqual({ rank: 1, size: 1, musdAhead: 0 });
    });
    it("is included in a plan", () => {
      expect(pl.plan(0.05, 160, terms({ queue: q })).queue).toEqual({ rank: 4, size: 4, musdAhead: 600 });
    });
  });

  it("reads BTC amounts leniently but safely", () => {
    expect(pl.parseBtc("0.05")).toBe(0.05);
    expect(pl.parseBtc("0,05")).toBe(0.05);
    expect(pl.parseBtc("abc")).toBe(0);
    expect(pl.parseBtc("-1")).toBe(0);
    expect(pl.parseBtc("0")).toBe(0);
    expect(pl.parseBtc("1000")).toBe(0);
    expect(pl.parseBtc("999.9")).toBe(999.9);
  });

  it("only writes values into the page as text", () => {
    expect(PLAN_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });
});

describe("the planner page", () => {
  const html = renderPlanPage({ appUrl: "https://testnet.mezo.org/borrow", botUsername: "creationnbot" });

  it("has the controls and the honest explanation", () => {
    expect(html).toContain('id="btc"');
    expect(html).toContain('type="range"');
    expect(html).toContain('data-ratio="160"');
    expect(html).toContain('data-sigma="0.6" aria-pressed="true"');
    expect(html).toContain('data-days="30" aria-pressed="true"');
    expect(html).toContain("Real crashes can be faster and deeper than this model");
    expect(html).toContain('href="https://testnet.mezo.org/borrow"');
    expect(html).toContain('href="https://t.me/creationnbot"');
    expect(html).toContain('<script src="/assets/plan.js"></script>');
  });

  it("is safe to serve under a strict policy", () => {
    expect(html).not.toMatch(/<script(?![^>]*src=)/i);
    expect(html).not.toMatch(/\son[a-z]+="/i);
    expect(html).not.toMatch(/src="https?:/i);
    expect(PLAN_HEADERS["content-security-policy"]).toContain("script-src 'self'");
    expect(PLAN_HEADERS["content-security-policy"]).toContain("default-src 'none'");
  });

  it("serves the page and the script", async () => {
    expect(planPageResponse({ appUrl: "x" }).headers.get("content-type")).toContain("text/html");
    expect(await planScriptResponse().text()).toBe(PLAN_JS);
  });
});
