import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderLanding } from "../src/landing.js";
import { renderPlanPage } from "../src/pages/plan.js";
import { renderPositionPage } from "../src/pages/position.js";
import { FAVICON, MARK_SVG } from "../src/pages/theme.js";

const pages = {
  landing: renderLanding({ botUsername: "creationnbot", appUrl: "https://x.test" }),
  position: renderPositionPage({ appUrl: "https://x.test", botUsername: "creationnbot" }),
  plan: renderPlanPage({ appUrl: "https://x.test", botUsername: "creationnbot" }),
};

describe("the logo", () => {
  it("is an inline SVG that screen readers skip, since the word Tripwire sits beside it", () => {
    expect(MARK_SVG).toContain('aria-hidden="true"');
    expect(MARK_SVG).toContain('focusable="false"');
  });

  it("is also the browser-tab icon, as a self-contained data URL", () => {
    expect(FAVICON.startsWith("data:image/svg+xml,")).toBe(true);
    const svg = decodeURIComponent(FAVICON.slice("data:image/svg+xml,".length));
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 512 512"');
  });

  for (const [name, html] of Object.entries(pages)) {
    it(`appears on the ${name} page with the favicon, and nothing is fetched for it`, () => {
      expect(html).toContain(MARK_SVG);
      expect(html).toContain(`<link rel="icon" href="${FAVICON}">`);
      expect(html).not.toContain("🛡");
      expect(html).not.toMatch(/<img[^>]+src="https?:/i);
    });
  }

  it("matches the files in docs/, so the site and the downloads cannot drift apart", () => {
    for (const f of ["logo-mark.svg", "bot-avatar.svg", "logo-wordmark.svg", "logo-wordmark-dark.svg"]) {
      const svg = readFileSync(`docs/${f}`, "utf8");
      for (const colour of ["#18213a", "#c2334a", "#ea9144", "#3bb47d"]) expect(svg, `${f} ${colour}`).toContain(colour);
    }
    for (const f of ["logo-mark-512.png", "bot-avatar-640.png", "logo-wordmark.png", "logo-wordmark-dark.png", "social-preview.png"]) {
      expect(existsSync(`docs/${f}`), f).toBe(true);
    }
  });

  it("is shown at the top of the README, in both light and dark themes", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("docs/logo-wordmark.png");
    expect(readme).toContain("docs/logo-wordmark-dark.png");
    expect(readme).toContain("prefers-color-scheme: dark");
  });
});
