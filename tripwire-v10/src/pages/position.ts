import { FAVICON, LOGO_CSS, MARK_SVG, SANS, SERIF, TOKENS_CSS, esc } from "./theme.js";

export interface PositionPageOptions {
  /** Where users go to add collateral or repay. */
  appUrl: string;
  botUsername?: string;
}

/**
 * The browser script. It is served as its own file (`script-src 'self'`) so the page can run with a strict
 * Content-Security-Policy. The maths at the top is pure and has no DOM access, so the tests run this very
 * file in Node and check the numbers. Keep `${` and backticks out of it: it lives in a template string.
 */
export const POSITION_JS = String.raw`(function () {
  "use strict";

  function tierFor(ratio, t) {
    if (ratio < t.liquidationBelowPct) return "liquidatable";
    if (ratio < t.urgentBelowPct) return "urgent";
    if (ratio < t.warningBelowPct) return "warning";
    if (ratio < t.watchBelowPct) return "watch";
    return "safe";
  }

  // What happens to this loan if BTC falls by dropPct percent, and what restores a target ratio at that price.
  function whatIf(p, dropPct, targetPct) {
    var price = p.btcPrice * (1 - dropPct / 100);
    var ratio = p.debtMusd > 0 ? ((p.collateralBtc * price) / p.debtMusd) * 100 : Infinity;
    var target = targetPct / 100;
    var addBtc = 0;
    var repayMusd = 0;
    if (p.debtMusd > 0 && price > 0) {
      addBtc = Math.max(0, (target * p.debtMusd) / price - p.collateralBtc);
      repayMusd = Math.max(0, p.debtMusd - (p.collateralBtc * price) / target);
    }
    return {
      price: price,
      ratio: ratio,
      tier: tierFor(ratio, p.tiers),
      addBtc: addBtc,
      repayMusd: repayMusd,
      liquidatable: ratio < p.tiers.liquidationBelowPct
    };
  }

  function dropToLiquidation(p) {
    return p.btcPrice > 0 ? Math.max(0, (1 - p.liquidationPrice / p.btcPrice) * 100) : 0;
  }

  function num(n, min, max) {
    return n.toLocaleString("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
  }
  function usd(n) { return "$" + num(n, 2, 2); }
  function btc(n) { return num(n, 0, 6) + " BTC"; }
  function musd(n) { return num(n, 2, 2) + " MUSD"; }
  function pct(n) { return isFinite(n) ? num(n, 2, 2) + "%" : "no debt"; }
  function shorten(a) { return a.slice(0, 6) + "\u2026" + a.slice(-4); }
  function label(tier) { return tier.charAt(0).toUpperCase() + tier.slice(1); }

  if (typeof document === "undefined") {
    globalThis.__tripwire = { tierFor: tierFor, whatIf: whatIf, dropToLiquidation: dropToLiquidation, usd: usd, btc: btc, musd: musd, pct: pct, shorten: shorten };
    return;
  }

  // ---- Page ----
  var ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  var RANGE_MIN = 100;
  var RANGE_MAX = 200;
  var state = { address: "", data: null, target: 150 };

  function $(id) { return document.getElementById(id); }
  function setText(id, text) { $(id).textContent = text; }
  function show(id, on) { $(id).hidden = !on; }
  function setMsg(text, isError) {
    var m = $("msg");
    m.textContent = text;
    m.setAttribute("role", isError ? "alert" : "status");
    m.className = isError ? "msg error" : "msg";
  }
  function at(ratio) { return Math.min(100, Math.max(0, ratio - RANGE_MIN)); }

  function buildRuler(t) {
    var bar = $("bar");
    var ticks = $("ticks");
    if (bar.getAttribute("data-built")) return;
    var edges = [RANGE_MIN, t.liquidationBelowPct, t.urgentBelowPct, t.warningBelowPct, t.watchBelowPct, RANGE_MAX];
    var names = ["liquidatable", "urgent", "warning", "watch", "safe"];
    for (var i = 0; i < names.length; i++) {
      var seg = document.createElement("span");
      seg.className = "seg " + names[i];
      seg.style.width = ((edges[i + 1] - edges[i]) / (RANGE_MAX - RANGE_MIN)) * 100 + "%";
      bar.insertBefore(seg, $("markerNow"));
    }
    for (var j = 1; j < 5; j++) {
      var tick = document.createElement("span");
      tick.textContent = String(edges[j]);
      tick.style.left = at(edges[j]) + "%";
      ticks.appendChild(tick);
    }
    bar.setAttribute("data-built", "1");
  }

  function setChip(id, tier) {
    var el = $(id);
    el.className = "chip t-" + tier;
    el.textContent = label(tier);
  }

  function render(d) {
    state.data = d;
    if (!d.active) {
      show("result", false);
      setMsg("No active loan found for that address on Mezo testnet.", false);
      return;
    }
    setMsg("", false);
    show("result", true);
    buildRuler(d.tiers);
    setChip("tier", d.tier);
    setText("who", shorten(d.address));
    setText("age", "Updated " + (d.snapshotAgeSec < 90 ? "just now" : Math.round(d.snapshotAgeSec / 60) + " min ago"));
    setText("price", usd(d.btcPrice));
    setText("coll", btc(d.collateralBtc));
    setText("debt", musd(d.debtMusd));
    setText("ratio", pct(d.ratioPct));
    setText("liq", usd(d.liquidationPrice) + " (" + num(dropToLiquidation(d), 1, 1) + "% below now)");
    if (d.redemption) {
      setText("queue", d.redemption.rank + " of " + d.redemption.queueSize + ", with about " + num(d.redemption.musdAhead, 0, 0) + " MUSD to be redeemed first");
    } else {
      setText("queue", "Not in the queue (below the liquidation line)");
    }
    var now = $("markerNow");
    now.style.left = at(d.ratioPct) + "%";
    update();
  }

  function update() {
    var d = state.data;
    if (!d || !d.active) return;
    var drop = Number($("drop").value);
    var w = whatIf(d, drop, state.target);
    setText("dropOut", drop === 0 ? "No change" : "BTC down " + drop + "%");
    $("markerSim").style.left = at(w.ratio) + "%";
    $("markerSim").hidden = drop === 0;
    setText("simPrice", usd(w.price));
    setText("simRatio", pct(w.ratio));
    setChip("simTier", w.tier);
    var fix = "";
    if (w.liquidatable) fix = "At that price this loan would be liquidatable. ";
    if (w.addBtc > 0 || w.repayMusd > 0) {
      fix += "To be back at " + state.target + "% at that price: add " + btc(w.addBtc) + " or repay " + musd(w.repayMusd) + ".";
    } else {
      fix += "No action needed at that price.";
    }
    setText("fix", fix);
  }

  function load(address, quiet) {
    if (!quiet) setMsg("Looking it up\u2026", false);
    return fetch("/api/position?address=" + encodeURIComponent(address), { headers: { accept: "application/json" } })
      .then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, body: j }; });
      })
      .then(function (res) {
        if (!res.ok) {
          show("result", false);
          setMsg((res.body && res.body.error) || "Something went wrong. Please try again.", true);
          return;
        }
        render(res.body);
      })
      .catch(function () {
        setMsg("Couldn't reach the server. Check your connection and try again.", true);
      });
  }

  function lookup() {
    var a = $("addr").value.trim();
    if (!ADDRESS.test(a)) {
      show("result", false);
      setMsg("That doesn't look like a wallet address. It should start with 0x and be 42 characters long.", true);
      return;
    }
    state.address = a;
    try { history.replaceState(null, "", "?a=" + a); } catch (e) { /* not important */ }
    load(a, false);
  }

  $("go").addEventListener("click", lookup);
  $("addr").addEventListener("keydown", function (e) { if (e.key === "Enter") lookup(); });
  $("drop").addEventListener("input", update);
  var chips = document.querySelectorAll("[data-target]");
  for (var c = 0; c < chips.length; c++) {
    chips[c].addEventListener("click", function (e) {
      state.target = Number(e.currentTarget.getAttribute("data-target"));
      for (var k = 0; k < chips.length; k++) chips[k].setAttribute("aria-pressed", chips[k] === e.currentTarget ? "true" : "false");
      update();
    });
  }
  setInterval(function () { if (!document.hidden && state.address) load(state.address, true); }, 60000);

  var fromUrl = new URLSearchParams(location.search).get("a");
  if (fromUrl) {
    $("addr").value = fromUrl;
    lookup();
  }
})();
`;

const CSS = `${TOKENS_CSS}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:1.0625rem/1.55 ${SANS}}
.wrap{max-width:46rem;margin:0 auto;padding:0 1.25rem}
a{color:var(--link)}
a:focus-visible,button:focus-visible,input:focus-visible,.btn:focus-visible{outline:3px solid var(--focus);outline-offset:3px;border-radius:6px}
h1,h2{font-family:${SERIF};line-height:1.15;margin:0;font-weight:600}
h1{font-size:clamp(1.9rem,6vw,2.6rem);letter-spacing:-.01em}
h2{font-size:1.5rem}
.top{display:flex;justify-content:space-between;align-items:center;padding:1.25rem 0}
${LOGO_CSS}
.brand{font-family:${SERIF};font-weight:600;font-size:1.125rem;color:var(--ink);text-decoration:none}
.lede{color:var(--muted);margin:.75rem 0 0;max-width:34rem}
.lookup{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.5rem}
.lookup input{flex:1 1 16rem;min-width:0;font:1rem ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:.8rem .9rem}
.btn{display:inline-block;background:var(--tg);color:#fff;text-decoration:none;font:600 1rem ${SANS};padding:.8rem 1.4rem;border:0;border-radius:10px;cursor:pointer}
.btn:hover{filter:brightness(1.08)}
.msg{margin:1rem 0 0;color:var(--muted);min-height:1.5rem}
.msg.error{color:var(--urgent);font-weight:600}
.panel{margin-top:2rem;padding-top:1.75rem;border-top:1px solid var(--line)}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;color:var(--muted);font-size:.9375rem}
.chip{display:inline-flex;align-items:center;gap:.5rem;font-weight:600;font-size:.9375rem;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:.2rem .8rem .2rem .65rem}
.chip::before{content:"";width:.7rem;height:.7rem;border-radius:50%;background:var(--muted)}
.t-safe::before{background:var(--safe)}.t-watch::before{background:var(--watch)}.t-warning::before{background:var(--warning)}.t-urgent::before{background:var(--urgent)}.t-liquidatable::before{background:var(--liq)}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.1rem 1.5rem;margin:1.5rem 0 0}
.stats div{min-width:0}
.stats dt{color:var(--muted);font-size:.875rem}
.stats dd{margin:.15rem 0 0;font-size:1.2rem;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.stats .wide{grid-column:1/-1}
.stats .wide dd{font-size:1.0625rem}
.ruler{position:relative;margin:5.5rem 0 0;padding-bottom:2rem}
.bar{position:relative;display:flex;height:1.5rem;border-radius:6px}
.seg{display:block;height:100%}
.seg:first-child{border-radius:6px 0 0 6px}
.seg:nth-child(5){border-radius:0 6px 6px 0}
.liquidatable{background:var(--liq)}.urgent{background:var(--urgent)}.warning{background:var(--warning)}.watch{background:var(--watch)}.safe{background:var(--safe)}
.marker{position:absolute;top:-.6rem;bottom:-.6rem;width:3px;margin-left:-1.5px;background:var(--ink);border-radius:2px;transition:left .2s ease}
.marker span{position:absolute;bottom:calc(100% + .3rem);left:50%;transform:translateX(-50%);white-space:nowrap;font-size:.8125rem;font-weight:600;background:var(--ink);color:var(--bg);padding:.15rem .55rem;border-radius:6px}
.marker.sim{background:var(--tg);top:-2.9rem}
.marker.sim span{background:var(--tg);color:#fff;bottom:calc(100% + .3rem)}
@media (prefers-reduced-motion:reduce){.marker{transition:none}}
.ticks{position:relative;height:1.25rem;margin-top:.5rem;font-size:.8125rem;color:var(--muted);font-variant-numeric:tabular-nums}
.ticks span{position:absolute;transform:translateX(-50%)}
.axis{font-size:.8125rem;color:var(--muted)}
.whatif{margin-top:2.25rem}
.whatif input[type=range]{width:100%;height:2.25rem;margin:.75rem 0 0;accent-color:var(--tg)}
.out{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.25rem;margin-top:.5rem;font-variant-numeric:tabular-nums}
.out strong{font-size:1.35rem}
.targets{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem;align-items:center}
.targets button{font:600 .9375rem ${SANS};color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:.4rem .9rem;cursor:pointer}
.targets button[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.fix{margin:1rem 0 0;max-width:36rem}
.cta{margin-top:1.5rem}
footer{border-top:1px solid var(--line);margin-top:3rem;padding:1.5rem 0 3rem;color:var(--muted);font-size:.9375rem}
`;

export function renderPositionPage(o: PositionPageOptions): string {
  const bot = o.botUsername && /^[A-Za-z0-9_]{3,64}$/.test(o.botUsername) ? o.botUsername : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Check your MUSD loan - Tripwire</title>
<meta name="description" content="See where your Mezo MUSD loan stands, how far BTC can fall before liquidation, and your place in the redemption queue.">
<meta name="theme-color" content="#18213a">
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top"><a class="brand" href="/">${MARK_SVG}Tripwire</a>${bot ? `<a href="https://t.me/${esc(bot)}">Open the bot</a>` : ""}</header>
<main>
<h1>Check your MUSD loan</h1>
<p class="lede">Paste the wallet address that holds your loan. See how far BTC can fall before liquidation, and drag the slider to try it.</p>
<div class="lookup">
<input id="addr" type="text" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="0x..." aria-label="Wallet address">
<button id="go" class="btn" type="button">Look it up</button>
</div>
<p id="msg" class="msg" role="status"></p>

<section id="result" class="panel" hidden>
<div class="head"><span id="tier" class="chip">Safe</span><span id="who"></span><span id="age"></span></div>
<dl class="stats">
<div><dt>BTC price</dt><dd id="price"></dd></div>
<div><dt>Collateral ratio</dt><dd id="ratio"></dd></div>
<div><dt>Collateral</dt><dd id="coll"></dd></div>
<div><dt>Debt</dt><dd id="debt"></dd></div>
<div class="wide"><dt>Liquidation price</dt><dd id="liq"></dd></div>
<div class="wide"><dt>Redemption queue</dt><dd id="queue"></dd></div>
</dl>

<div class="ruler" role="img" aria-label="Where your collateral ratio sits between liquidation at 110 percent and safe above 150 percent">
<div id="bar" class="bar">
<div id="markerNow" class="marker"><span>now</span></div>
<div id="markerSim" class="marker sim" hidden><span>if BTC falls</span></div>
</div>
<div id="ticks" class="ticks"></div>
<div class="axis">Collateral ratio, in percent</div>
</div>

<div class="whatif">
<h2>What if BTC falls?</h2>
<label for="drop" class="lede" style="display:block;margin-top:.5rem">Drag to try a fall from 0% to 60%.</label>
<input id="drop" type="range" min="0" max="60" step="1" value="0">
<div class="out" aria-live="polite">
<strong id="dropOut">No change</strong>
<span>Price <span id="simPrice"></span></span>
<span>Ratio <span id="simRatio"></span></span>
<span id="simTier" class="chip">Safe</span>
</div>
<div class="targets" role="group" aria-label="Target ratio">
<span>Get back to</span>
<button type="button" data-target="135" aria-pressed="false">135%</button>
<button type="button" data-target="150" aria-pressed="true">150%</button>
<button type="button" data-target="200" aria-pressed="false">200%</button>
</div>
<p id="fix" class="fix"></p>
<p class="cta"><a class="btn" href="${esc(o.appUrl)}">Add collateral or repay on Mezo</a></p>
</div>
</section>
</main>
<footer>Live data from Mezo testnet, read-only. Tripwire never asks for keys and cannot move funds. Not financial advice.</footer>
</div>
<script src="/assets/position.js"></script>
</body>
</html>`;
}

/** Telegram opens Mini Apps inside its own web client too, so that is the one place the page may be framed. */
export const POSITION_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=300",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://telegram.org",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export const SCRIPT_HEADERS: Record<string, string> = {
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff",
};

export function positionPageResponse(o: PositionPageOptions): Response {
  return new Response(renderPositionPage(o), { status: 200, headers: POSITION_HEADERS });
}
export function positionScriptResponse(): Response {
  return new Response(POSITION_JS, { status: 200, headers: SCRIPT_HEADERS });
}
