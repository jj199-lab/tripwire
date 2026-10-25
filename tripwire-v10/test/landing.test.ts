import { describe, expect, it } from "vitest";
import { LANDING_HEADERS, landingResponse, renderLanding } from "../src/landing.js";
import { DEFAULT_TIERS, MCR } from "../src/risk.js";

const opts = { botUsername: "creationnbot", appUrl: "https://testnet.mezo.org/borrow" };

describe("landing page", () => {
  it("links to the bot and shows the real tier thresholds", () => {
    const html = renderLanding(opts);
    expect(html).toContain('href="https://t.me/creationnbot"');
    expect(html).toContain("Open in Telegram");
    for (const wad of [MCR, DEFAULT_TIERS.upper.urgent, DEFAULT_TIERS.upper.warning, DEFAULT_TIERS.upper.watch]) {
      expect(html).toContain(`below ${Number(wad) / 1e16}%`);
    }
    expect(html).toContain("testnet.mezo.org/borrow");
    expect(html).toContain("<title>Tripwire:");
    expect(html).not.toContain("Trove Guardian");
  });

  it("has no scripts, no remote resources and a strict policy", () => {
    const html = renderLanding(opts);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src="https?:/i);
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
    expect(LANDING_HEADERS["content-security-policy"]).toContain("default-src 'none'");
    expect(LANDING_HEADERS["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(LANDING_HEADERS["content-type"]).toContain("text/html");
    expect(LANDING_HEADERS["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects unsafe bot usernames and repo links", () => {
    const bad = renderLanding({ ...opts, botUsername: 'x"><img src=x onerror=1>', repoUrl: "javascript:alert(1)" });
    expect(bad).not.toContain("t.me/");
    expect(bad).not.toContain("javascript:");
    expect(bad).not.toContain("<img src=x");
    expect(bad).toContain("Bot link coming soon");
  });

  it("shows the repo link only when it is https", () => {
    expect(renderLanding(opts)).not.toContain("Source code on GitHub");
    expect(renderLanding({ ...opts, repoUrl: "https://github.com/someone/trove-guardian" })).toContain('href="https://github.com/someone/trove-guardian"');
  });

  it("describes the ruler for screen readers and respects reduced motion", () => {
    const html = renderLanding(opts);
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label=");
    expect(html).toContain("prefers-reduced-motion:reduce");
    expect(html).toContain('<html lang="en">');
  });

  it("serves a 200 HTML response", async () => {
    const res = landingResponse(opts);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain("Know your tripwire before you borrow");
  });

  it("is well-formed enough: every opened tag is closed", () => {
    const html = renderLanding({ ...opts, repoUrl: "https://github.com/a/b" });
    const void_ = new Set(["meta", "link", "br", "img", "input", "hr"]);
    const stack: string[] = [];
    for (const m of html.matchAll(/<\/?([a-zA-Z0-9]+)[^>]*?(\/?)>/g)) {
      const [whole, tag, selfClose] = m as unknown as [string, string, string];
      const name = tag.toLowerCase();
      if (name === "!doctype" || void_.has(name) || selfClose) continue;
      if (whole.startsWith("</")) expect(stack.pop()).toBe(name);
      else stack.push(name);
    }
    expect(stack).toEqual([]);
  });
});
