import { DEFAULT_TIERS, MCR } from "./risk.js";
import { REDEMPTION_ENTER_RANK } from "./alerts.js";

export interface LandingOptions {
  /** Telegram username without the @. The Telegram button is left out if this is missing or invalid. */
  botUsername?: string;
  /** Public GitHub link. Left out unless it starts with https://. */
  repoUrl?: string;
  /** Where users go to add collateral or repay. */
  appUrl: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const pts = (wad: bigint): number => Number(wad) / 1e16;

// The ruler is drawn from the same thresholds the bot uses, so the page can't drift from the product.
const LIQ = pts(MCR);
const URGENT = pts(DEFAULT_TIERS.upper.urgent);
const WARNING = pts(DEFAULT_TIERS.upper.warning);
const WATCH = pts(DEFAULT_TIERS.upper.watch);
const MIN = 100;
const MAX = 200;
const span = (a: number, b: number): number => ((b - a) / (MAX - MIN)) * 100;
const at = (v: number): number => ((v - MIN) / (MAX - MIN)) * 100;

// Sample position shown in the hero: 0.05 BTC backing 2,202 MUSD, BTC at $51,702 gives 117.40%.
const SAMPLE_RATIO = 117.4;

const CSS = `
:root{--bg:#edf1f5;--surface:#fff;--ink:#18213a;--muted:#525d78;--line:#c9d1de;--chip:#e0e6ee;--tg:#1b6fb5;--link:#1b6fb5;--focus:#1b6fb5;
--liq:#8a1c2b;--urgent:#d6453d;--warning:#e27d2a;--watch:#d9a21b;--safe:#2e9e6b}
@media (prefers-color-scheme:dark){:root{--bg:#0f1626;--surface:#17203a;--ink:#e8ecf5;--muted:#a3aec8;--line:#2c3758;--chip:#232e4d;--tg:#2a82cf;--link:#7db8f0;--focus:#7db8f0;
--liq:#c2334a;--urgent:#e8605a;--warning:#ea9144;--watch:#e2b12e;--safe:#3bb47d}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:1.0625rem/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:68rem;margin:0 auto;padding:0 1.25rem}
a{color:var(--link)}
a:focus-visible,.btn:focus-visible{outline:3px solid var(--focus);outline-offset:3px;border-radius:4px}
h1,h2,h3{font-family:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;line-height:1.15;margin:0;font-weight:600}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--chip);padding:.1em .4em;border-radius:5px}
.top{display:flex;justify-content:space-between;align-items:center;padding:1.25rem 0}
.brand{font-family:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-weight:600;font-size:1.125rem}
.hero{display:grid;gap:2.5rem;padding:2rem 0 3.5rem}
@media (min-width:56rem){.hero{grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:3.5rem;align-items:center;padding:3rem 0 4.5rem}}
.hero h1{font-size:clamp(2.4rem,5.4vw,3.75rem);letter-spacing:-.015em;max-width:18ch;text-wrap:balance}
.lede{text-wrap:pretty;font-size:1.1875rem;color:var(--muted);max-width:34rem;margin:1.25rem 0 0}
.actions{display:flex;flex-wrap:wrap;gap:1rem 1.5rem;align-items:center;margin-top:2rem}
.btn{display:inline-block;background:var(--tg);color:#fff;text-decoration:none;font-weight:600;padding:.8rem 1.4rem;border-radius:10px}
.btn:hover{filter:brightness(1.08)}
.alert{margin:0;background:var(--surface);border:1px solid var(--line);border-left:5px solid var(--urgent);border-radius:14px;padding:1.1rem 1.25rem 1rem;box-shadow:0 1px 0 var(--line)}
.alert .who{font-weight:600;font-size:.9375rem;margin-bottom:.5rem}
.alert pre{margin:0;font:.9375rem/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;white-space:pre-wrap;word-break:break-word;font-variant-numeric:tabular-nums}
.alert figcaption{margin-top:.9rem;font-size:.875rem;color:var(--muted)}
.band{border-top:1px solid var(--line);padding:3.5rem 0}
.band h2{font-size:clamp(1.65rem,3.4vw,2.25rem);max-width:24ch;text-wrap:balance}
.band .sub{color:var(--muted);max-width:40rem;margin:1rem 0 0}
.ruler{position:relative;margin:4rem 0 0;padding-bottom:2.25rem}
.bar{position:relative;display:flex;height:1.5rem;border-radius:6px;overflow:visible}
.seg{display:block;height:100%}
.seg:first-child{border-radius:6px 0 0 6px}
.seg:last-of-type{border-radius:0 6px 6px 0}
.liquidatable{background:var(--liq)}.urgent{background:var(--urgent)}.warning{background:var(--warning)}.watch{background:var(--watch)}.safe{background:var(--safe)}
.marker{position:absolute;top:-.6rem;bottom:-.6rem;width:3px;margin-left:-1.5px;background:var(--ink);border-radius:2px;left:${at(SAMPLE_RATIO).toFixed(1)}%;animation:slide 3.4s cubic-bezier(.45,0,.2,1) .7s both}
.marker span{position:absolute;bottom:calc(100% + .35rem);left:50%;transform:translateX(-50%);white-space:nowrap;font-size:.8125rem;font-weight:600;background:var(--ink);color:var(--bg);padding:.15rem .55rem;border-radius:6px}
@keyframes slide{from{left:${at(184).toFixed(1)}%}to{left:${at(SAMPLE_RATIO).toFixed(1)}%}}
@media (prefers-reduced-motion:reduce){.marker{animation:none}}
.ticks{position:relative;height:1.25rem;margin-top:.5rem;font-size:.8125rem;color:var(--muted);font-variant-numeric:tabular-nums}
.ticks span{position:absolute;transform:translateX(-50%)}
.axis{font-size:.8125rem;color:var(--muted);margin-top:.25rem}
.legend{list-style:none;margin:1.75rem 0 0;padding:0;display:grid;gap:.5rem 2rem;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))}
.legend li{display:flex;align-items:center;gap:.6rem}
.legend i{flex:none;width:.85rem;height:.85rem;border-radius:3px}
.features{display:grid;gap:2rem 3rem;margin:2.5rem 0 0}
@media (min-width:56rem){.features{grid-template-columns:repeat(3,minmax(0,1fr))}}
.features div{border-top:3px solid var(--ink);padding-top:1rem}
.features dt{font-family:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-weight:600;font-size:1.25rem;line-height:1.25}
.features dd{margin:.6rem 0 0;color:var(--muted)}
.steps{margin:2rem 0 0;padding-left:1.4rem;max-width:40rem}
.steps li{margin:.6rem 0;padding-left:.35rem}
.trust{border-left:4px solid var(--safe);padding:.25rem 0 .25rem 1.25rem;max-width:44rem;margin-top:1.5rem}
.trust p{margin:.5rem 0 0}
footer{border-top:1px solid var(--line);padding:2rem 0 3rem;color:var(--muted);font-size:.9375rem}
footer p{margin:.25rem 0}
`;

function ruler(): string {
  const segs: Array<[string, number]> = [
    ["liquidatable", span(MIN, LIQ)],
    ["urgent", span(LIQ, URGENT)],
    ["warning", span(URGENT, WARNING)],
    ["watch", span(WARNING, WATCH)],
    ["safe", span(WATCH, MAX)],
  ];
  const bar = segs.map(([c, w]) => `<span class="seg ${c}" style="width:${w.toFixed(2)}%"></span>`).join("");
  const ticks = [LIQ, URGENT, WARNING, WATCH].map((v) => `<span style="left:${at(v).toFixed(2)}%">${v}</span>`).join("");
  const label = `Collateral ratio scale from ${MIN} to ${MAX} percent. Below ${LIQ} percent a position can be liquidated. ${LIQ} to ${URGENT} is urgent, ${URGENT} to ${WARNING} is warning, ${WARNING} to ${WATCH} is watch, and above ${WATCH} is safe.`;
  return `<div class="ruler" role="img" aria-label="${esc(label)}">
<div class="bar">${bar}<div class="marker"><span>your ratio</span></div></div>
<div class="ticks">${ticks}</div>
<div class="axis">Collateral ratio, in percent</div>
</div>`;
}

export function renderLanding(o: LandingOptions): string {
  const bot = o.botUsername && /^[A-Za-z0-9_]{3,64}$/.test(o.botUsername) ? o.botUsername : "";
  const botUrl = bot ? `https://t.me/${bot}` : "";
  const repo = o.repoUrl && o.repoUrl.startsWith("https://") ? o.repoUrl : "";
  const cta = botUrl
    ? `<a class="btn" href="${esc(botUrl)}">Open in Telegram</a>`
    : `<span class="btn" aria-disabled="true">Bot link coming soon</span>`;
  const step1 = bot ? `Open <a href="${esc(botUrl)}">@${esc(bot)}</a> in Telegram and press Start.` : "Open the bot in Telegram and press Start.";

  const sample = [
    "🚨 ALERT: 0xa17D…aBd3 moved from WARNING to URGENT.",
    "",
    "🔴 URGENT",
    "Trove 0xa17D…aBd3",
    "",
    "BTC price: $51,702.00",
    "Collateral: 0.05 BTC",
    "Debt: 2,202.00 MUSD",
    `Collateral ratio: ${SAMPLE_RATIO.toFixed(2)}% (liquidation below ${LIQ.toFixed(2)}%)`,
    "Liquidation price: $48,444.00 (6.30% below the current price)",
    "",
    `Add collateral or repay: ${o.appUrl.replace(/^https:\/\//, "")}`,
  ].join("\n");

  const legend = [
    ["liquidatable", `Liquidatable: below ${LIQ}%`],
    ["urgent", `Urgent: below ${URGENT}%`],
    ["warning", `Warning: below ${WARNING}%`],
    ["watch", `Watch: below ${WATCH}%`],
    ["safe", `Safe: ${WATCH}% and above`],
  ]
    .map(([c, t]) => `<li><i class="${c}"></i>${esc(t as string)}</li>`)
    .join("");

  const title = "Tripwire: a watchtower for your MUSD loan";
  const desc =
    "A Telegram bot that messages you when your MUSD collateral ratio nears liquidation or your position moves up the redemption queue. Read-only, on Mezo testnet.";
  const favicon =
    "data:image/svg+xml," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🛡️</text></svg>');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#18213a">
<link rel="icon" href="${favicon}">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top"><span class="brand">Tripwire</span>${botUrl ? `<a href="${esc(botUrl)}">Open the bot</a>` : ""}</header>
<main>
<section class="hero">
<div>
<h1>A watchtower for your MUSD loan</h1>
<p class="lede">Tripwire messages you on Telegram when your collateral ratio nears liquidation, or when your position moves up the redemption queue.</p>
<div class="actions">${cta}<a href="#alerts">See how the alerts work</a></div>
</div>
<figure class="alert">
<div class="who">Tripwire</div>
<pre>${esc(sample)}</pre>
<figcaption>A sample alert. Real ones read the same, with live numbers from Mezo testnet.</figcaption>
</figure>
</section>

<section class="band" id="alerts">
<h2>Four lines between you and liquidation</h2>
<p class="sub">Your collateral ratio is what your Bitcoin is worth compared to the MUSD you borrowed. When BTC falls, your ratio slides left. The bot messages you each time it crosses a line, and again when you recover.</p>
${ruler()}
<ul class="legend">${legend}</ul>
</section>

<section class="band">
<h2>What it watches for you</h2>
<dl class="features">
<div><dt>Alerts when your ratio crosses a line</dt><dd>You get one message when your position moves into a riskier tier and one when it recovers. A 3-point buffer stops the bot repeating itself when your ratio hovers near a line.</dd></div>
<div><dt>A heads-up before a redemption</dt><dd>Redemptions take the lowest-ratio loans first, paying debt down at $1 per MUSD. It is not a liquidation, but you lose BTC exposure. If you are among the first ${REDEMPTION_ENTER_RANK} in the queue, the bot tells you.</dd></div>
<div><dt>A what-if simulator</dt><dd>Send <code>/simulate 30</code> to see your ratio and tier if BTC fell 30%, and how much collateral to add or MUSD to repay to get back to ${WATCH}%. Nothing happens on-chain.</dd></div>
</dl>
</section>

<section class="band">
<h2>Start in under a minute</h2>
<ol class="steps">
<li>${step1}</li>
<li>Send <code>/track</code> followed by the wallet address that holds your trove.</li>
<li>Close the chat. The bot checks about every minute and messages you if anything changes.</li>
</ol>
<div class="trust">
<h3>Read-only by design</h3>
<p>The bot only reads public blockchain data. It never asks for a private key or seed phrase, and it cannot move funds. It stores your Telegram chat ID, the public address you track, and the last alert state it sent you. Send <code>/untrack</code> to remove an address.</p>
</div>
</section>
</main>
<footer>
<p>Built for the Mezo Buildathon on AKINDO. Runs on Mezo testnet only. Not financial advice.</p>
${repo ? `<p><a href="${esc(repo)}">Source code on GitHub</a></p>` : ""}
</footer>
</div>
</body>
</html>`;
}

/** The page has no scripts, so the policy can block everything except inline styles and the favicon. */
export const LANDING_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=300",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function landingResponse(o: LandingOptions): Response {
  return new Response(renderLanding(o), { status: 200, headers: LANDING_HEADERS });
}
