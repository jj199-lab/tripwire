import { POSITION_HEADERS, SCRIPT_HEADERS } from "./position.js";
import { FAVICON, LOGO_CSS, MARK_SVG, SANS, SERIF, TOKENS_CSS, esc } from "./theme.js";

export interface PlanPageOptions {
  /** Where users go to actually borrow. */
  appUrl: string;
  botUsername?: string;
}

/**
 * Browser script for the borrow planner. The maths at the top is pure (no DOM), so the tests run this exact file in
 * Node. Formulas follow Mezo's BorrowerOperations.openTrove: the fee is charged on the amount borrowed (waived in
 * Recovery Mode), the 200 MUSD gas deposit is added to the debt, the minimum loan applies to amount plus fee, the
 * ratio must clear 110% (150% in Recovery Mode), and the whole system must stay at 150% or more after the loan.
 * Keep `${` and backticks out of it: it lives in a template string.
 */
export const PLAN_JS = String.raw`(function () {
  "use strict";

  // Standard normal cumulative distribution (Abramowitz and Stegun 7.1.26, error below 1.5e-7).
  function normCdf(x) {
    var t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
    var poly = 1.061405429;
    poly = poly * t - 1.453152027;
    poly = poly * t + 1.421413741;
    poly = poly * t - 0.284496736;
    poly = poly * t + 0.254829592;
    var erf = 1 - poly * t * Math.exp(-(x * x) / 2);
    return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
  }

  // Chance that BTC touches the liquidation price at least once within the window, if it moves randomly with the
  // given yearly volatility and no trend: 2 x N(-a / (sigma x sqrt(T))), where a = ln(ratio / liquidation line).
  function liquidationChance(ratioPct, liqPct, sigma, days) {
    if (ratioPct <= liqPct) return 1;
    var a = Math.log(ratioPct / liqPct);
    var s = sigma * Math.sqrt(days / 365);
    return Math.min(1, 2 * normCdf(-a / s));
  }

  function grade(p) {
    if (p < 0.01) return "Very low";
    if (p < 0.05) return "Low";
    if (p < 0.15) return "Moderate";
    if (p < 0.35) return "High";
    return "Very high";
  }

  // Where a new loan at ratioPct would sit in today's redemption queue. queue is sorted [ratio %, MUSD redeemable].
  function queuePosition(queue, ratioPct) {
    var below = 0;
    var ahead = 0;
    for (var i = 0; i < queue.length; i++) {
      if (queue[i][0] < ratioPct) {
        below++;
        ahead += queue[i][1];
      } else {
        break;
      }
    }
    return { rank: below + 1, size: queue.length + 1, musdAhead: ahead };
  }

  // Everything about a loan of btc BTC opened at ratioPct, under today's terms t.
  function plan(btc, ratioPct, t) {
    var debt = (btc * t.price) / (ratioPct / 100);
    var netDebt = debt - t.gas;
    var feeRate = t.recovery ? 0 : t.feePct / 100;
    var receive = netDebt > 0 ? netDebt / (1 + feeRate) : 0;
    var requiredRatio = t.recovery ? t.ccrPct : t.liqPct;
    var newTcr = ((t.totalColl + btc) * t.price) / (t.totalDebt + debt) * 100;
    var liqPrice = ((t.liqPct / 100) * debt) / btc;
    return {
      debt: debt,
      receive: receive,
      fee: netDebt > 0 ? netDebt - receive : 0,
      liqPrice: liqPrice,
      fallPct: (1 - liqPrice / t.price) * 100,
      interestYear: (debt * t.interestPct) / 100,
      requiredRatio: requiredRatio,
      ratioTooLow: ratioPct < requiredRatio,
      belowMinimum: netDebt < t.minLoan,
      minBtc: ((t.minLoan + t.gas) * (ratioPct / 100)) / t.price,
      newTcr: newTcr,
      blockedBySystem: !t.recovery && newTcr < t.ccrPct,
      queue: queuePosition(t.queue, ratioPct)
    };
  }

  function parseBtc(text) {
    var v = parseFloat(String(text).replace(",", "."));
    return isFinite(v) && v > 0 && v < 1000 ? v : 0;
  }

  function num(n, min, max) { return n.toLocaleString("en-US", { minimumFractionDigits: min, maximumFractionDigits: max }); }
  function usd(n) { return "$" + num(n, 2, 2); }
  function usd0(n) { return "$" + num(n, 0, 0); }
  function btcText(n) { return num(n, 0, 6) + " BTC"; }
  function musd(n) { return num(n, 2, 2) + " MUSD"; }
  function pctText(n, d) { return num(n, d, d) + "%"; }
  function chanceText(p) { return p < 0.001 ? "under 0.1%" : p > 0.99 ? "over 99%" : pctText(p * 100, p < 0.1 ? 1 : 0); }

  if (typeof document === "undefined") {
    globalThis.__plan = { normCdf: normCdf, liquidationChance: liquidationChance, grade: grade, queuePosition: queuePosition, plan: plan, parseBtc: parseBtc, chanceText: chanceText, usd: usd, musd: musd };
    return;
  }

  // ---- Page ----
  var LADDER = [125, 150, 175, 200, 250, 300];
  var RANGE_MIN = 100;
  var RANGE_MAX = 200;
  var data = null;
  var state = { sigma: 0.6, days: 30 };

  function $(id) { return document.getElementById(id); }
  function setText(id, text) { $(id).textContent = text; }
  function show(id, on) { $(id).hidden = !on; }
  function at(r) { return Math.min(100, Math.max(0, r - RANGE_MIN)); }

  function terms() {
    var p = data.params;
    return {
      price: data.btcPrice, recovery: data.recoveryMode, feePct: p.borrowingFeePct, minLoan: p.minLoanMusd, gas: p.gasDepositMusd,
      interestPct: p.interestRatePct, liqPct: p.liquidationBelowPct, ccrPct: p.recoveryBelowPct,
      totalColl: data.totalCollateralBtc, totalDebt: data.totalDebtMusd, queue: data.queue
    };
  }

  function buildRuler() {
    var t = terms();
    var bar = $("bar");
    var edges = [RANGE_MIN, t.liqPct, 120, 135, t.ccrPct, RANGE_MAX];
    var names = ["liquidatable", "urgent", "warning", "watch", "safe"];
    for (var i = 0; i < names.length; i++) {
      var seg = document.createElement("span");
      seg.className = "seg " + names[i];
      seg.style.width = ((edges[i + 1] - edges[i]) / (RANGE_MAX - RANGE_MIN)) * 100 + "%";
      bar.insertBefore(seg, $("marker"));
    }
    for (var j = 1; j < 5; j++) {
      var tick = document.createElement("span");
      tick.textContent = String(edges[j]);
      tick.style.left = at(edges[j]) + "%";
      $("ticks").appendChild(tick);
    }
  }

  function chip(id, p) {
    var g = grade(p);
    var el = $(id);
    el.textContent = g;
    el.className = "chip " + (p < 0.05 ? "t-safe" : p < 0.15 ? "t-watch" : p < 0.35 ? "t-warning" : "t-urgent");
  }

  function notice(text) {
    var n = $("notice");
    n.hidden = !text;
    n.textContent = text || "";
  }

  function recompute() {
    if (!data || !data.params) return;
    var t = terms();
    var btc = parseBtc($("btc").value);
    var ratio = Number($("ratio").value);
    setText("ratioOut", ratio + "%");
    setText("usd", btc > 0 ? "\u2248 " + usd0(btc * t.price) + " of BTC" : "");
    renderLadder(btc, t);
    if (btc <= 0) {
      show("out", false);
      return;
    }
    show("out", true);
    var r = plan(btc, ratio, t);
    var msg = "";
    if (r.ratioTooLow) {
      msg = t.recovery
        ? "Mezo is in Recovery Mode, so new loans need at least " + r.requiredRatio + "%. Move the slider up."
        : "Mezo needs at least " + r.requiredRatio + "% to open a loan. Move the slider up.";
    } else if (r.belowMinimum) {
      msg = "That is below Mezo's minimum loan of " + musd(t.minLoan) + ". At " + ratio + "% you would need at least " + btcText(r.minBtc) + ".";
    } else if (r.blockedBySystem) {
      msg = "Mezo would turn this loan down: it would push the whole system below " + t.ccrPct + "% (to " + pctText(r.newTcr, 1) + ").";
    }
    notice(msg);

    setText("receive", musd(r.receive));
    setText("fee", r.fee > 0 ? musd(r.fee) + " fee (" + t.feePct + "%)" : t.recovery ? "No fee in Recovery Mode" : "No fee");
    setText("debt", musd(r.debt));
    setText("liq", usd(r.liqPrice));
    setText("fall", pctText(r.fallPct, 1) + " drop from " + usd(t.price));
    setText("interest", "About " + musd(r.interestYear) + " a year (" + t.interestPct + "%, fixed)");
    setText("queue", "#" + r.queue.rank + " of " + r.queue.size + (r.queue.musdAhead > 0 ? ", about " + num(r.queue.musdAhead, 0, 0) + " MUSD redeemed before yours" : ""));
    $("marker").style.left = at(ratio) + "%";

    var p = liquidationChance(ratio, t.liqPct, state.sigma, state.days);
    chip("grade", p);
    setText("chance", "About " + chanceText(p) + " chance of being liquidated within " + state.days + " days, assuming " + sigmaWord() + " BTC swings.");
    $("btc").setAttribute("aria-invalid", "false");
  }

  function sigmaWord() { return state.sigma <= 0.4 ? "calm" : state.sigma <= 0.6 ? "typical" : "wild"; }

  function renderLadder(btc, t) {
    var body = $("ladder");
    while (body.firstChild) body.removeChild(body.firstChild);
    if (btc <= 0) return;
    for (var i = 0; i < LADDER.length; i++) {
      var ratio = LADDER[i];
      var r = plan(btc, ratio, t);
      var tr = document.createElement("tr");
      var cells = [
        ratio + "%",
        r.ratioTooLow ? "Not allowed" : r.belowMinimum ? "Below minimum" : r.blockedBySystem ? "Not allowed" : num(r.receive, 0, 0) + " MUSD",
        pctText(r.fallPct, 0),
        chanceText(liquidationChance(ratio, t.liqPct, state.sigma, state.days)),
        "#" + r.queue.rank + " of " + r.queue.size
      ];
      for (var c = 0; c < cells.length; c++) {
        var td = document.createElement("td");
        td.textContent = cells[c];
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  function press(group, attr, value) {
    var els = document.querySelectorAll("[" + attr + "]");
    for (var i = 0; i < els.length; i++) {
      var on = els[i].getAttribute(attr) === String(value);
      if (els[i].parentNode === group) els[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function wire() {
    $("btc").addEventListener("input", recompute);
    $("ratio").addEventListener("input", recompute);
    var presets = document.querySelectorAll("[data-ratio]");
    for (var i = 0; i < presets.length; i++) {
      presets[i].addEventListener("click", function (e) {
        $("ratio").value = e.currentTarget.getAttribute("data-ratio");
        recompute();
      });
    }
    var vols = document.querySelectorAll("[data-sigma]");
    for (var j = 0; j < vols.length; j++) {
      vols[j].addEventListener("click", function (e) {
        state.sigma = Number(e.currentTarget.getAttribute("data-sigma"));
        press(e.currentTarget.parentNode, "data-sigma", state.sigma);
        recompute();
      });
    }
    var spans = document.querySelectorAll("[data-days]");
    for (var k = 0; k < spans.length; k++) {
      spans[k].addEventListener("click", function (e) {
        state.days = Number(e.currentTarget.getAttribute("data-days"));
        press(e.currentTarget.parentNode, "data-days", state.days);
        recompute();
      });
    }
  }

  function boot() {
    fetch("/api/plan", { headers: { accept: "application/json" } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.body.params) {
          setText("status", (res.body && res.body.error) || "Today's loan terms are not loaded yet. Try again in a minute.");
          $("status").className = "msg error";
          return;
        }
        data = res.body;
        setText("status", "Using live Mezo testnet terms: BTC " + usd(data.btcPrice) + ", fee " + data.params.borrowingFeePct + "%, interest " + data.params.interestRatePct + "% a year" + (data.recoveryMode ? ", Recovery Mode on" : "") + ".");
        $("status").className = "msg";
        show("planner", true);
        buildRuler();
        wire();
        recompute();
      })
      .catch(function () {
        setText("status", "Couldn't reach the server. Check your connection and try again.");
        $("status").className = "msg error";
      });
  }

  boot();
})();
`;

const CSS = `${TOKENS_CSS}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:1.0625rem/1.55 ${SANS}}
.wrap{max-width:46rem;margin:0 auto;padding:0 1.25rem}
a{color:var(--link)}
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible,.btn:focus-visible{outline:3px solid var(--focus);outline-offset:3px;border-radius:6px}
h1,h2{font-family:${SERIF};line-height:1.15;margin:0;font-weight:600}
h1{font-size:clamp(1.9rem,6vw,2.6rem);letter-spacing:-.01em}
h2{font-size:1.4rem}
.top{display:flex;justify-content:space-between;align-items:center;padding:1.25rem 0}
${LOGO_CSS}
.top nav{display:flex;gap:1.25rem}
.brand{font-family:${SERIF};font-weight:600;font-size:1.125rem;color:var(--ink);text-decoration:none}
.lede{color:var(--muted);margin:.75rem 0 0;max-width:36rem}
.msg{margin:1rem 0 0;color:var(--muted)}
.msg.error{color:var(--urgent);font-weight:600}
.panel{margin-top:1.75rem;padding-top:1.5rem;border-top:1px solid var(--line)}
label,.label{display:block;font-weight:600;margin-top:1.25rem}
label:first-child{margin-top:0}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;margin-top:.4rem}
.row input{width:11rem;font:1.125rem ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:.65rem .8rem}
.hint{color:var(--muted);font-weight:400}
input[type=range]{width:100%;height:2.25rem;margin:.4rem 0 0;accent-color:var(--tg)}
.chips{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.5rem;align-items:center}
.chips button{font:600 .9375rem ${SANS};color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:.4rem .9rem;cursor:pointer}
.chips button[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.chips .tag{color:var(--muted);font-weight:400;font-size:.9375rem;margin-right:.25rem}
.big{margin:0;font-size:1.05rem;color:var(--muted)}
.big strong{display:block;font-family:${SERIF};font-size:clamp(2rem,8vw,2.8rem);color:var(--ink);line-height:1.1}
.notice{margin:1rem 0 0;padding:.75rem 1rem;border-left:4px solid var(--warning);background:var(--surface);font-weight:600}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.1rem 1.5rem;margin:1.5rem 0 0}
.stats div{min-width:0}
.stats dt{color:var(--muted);font-size:.875rem}
.stats dd{margin:.15rem 0 0;font-size:1.0625rem;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.stats .wide{grid-column:1/-1}
.verdict{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem 1rem;margin-top:1.5rem}
.verdict p{margin:0;flex:1 1 16rem}
.chip{display:inline-flex;align-items:center;gap:.5rem;font-weight:600;font-size:.9375rem;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:.2rem .8rem .2rem .65rem}
.chip::before{content:"";width:.7rem;height:.7rem;border-radius:50%;background:var(--muted)}
.t-safe::before{background:var(--safe)}.t-watch::before{background:var(--watch)}.t-warning::before{background:var(--warning)}.t-urgent::before{background:var(--urgent)}
.ruler{position:relative;margin:3.25rem 0 0;padding-bottom:2rem}
.bar{position:relative;display:flex;height:1.25rem;border-radius:6px}
.seg{display:block;height:100%}
.seg:first-child{border-radius:6px 0 0 6px}
.seg:nth-child(5){border-radius:0 6px 6px 0}
.liquidatable{background:var(--liq)}.urgent{background:var(--urgent)}.warning{background:var(--warning)}.watch{background:var(--watch)}.safe{background:var(--safe)}
.marker{position:absolute;top:-.6rem;bottom:-.6rem;width:3px;margin-left:-1.5px;background:var(--ink);border-radius:2px;transition:left .2s ease}
.marker span{position:absolute;bottom:calc(100% + .3rem);left:50%;transform:translateX(-50%);white-space:nowrap;font-size:.8125rem;font-weight:600;background:var(--ink);color:var(--bg);padding:.15rem .55rem;border-radius:6px}
@media (prefers-reduced-motion:reduce){.marker{transition:none}}
.ticks{position:relative;height:1.25rem;margin-top:.5rem;font-size:.8125rem;color:var(--muted);font-variant-numeric:tabular-nums}
.ticks span{position:absolute;transform:translateX(-50%)}
.scroll{overflow-x:auto;margin-top:1rem}
table{border-collapse:collapse;width:100%;min-width:30rem;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:.6rem .5rem;border-bottom:1px solid var(--line);font-size:.9375rem}
th{color:var(--muted);font-weight:600;font-size:.8125rem}
.cta{display:flex;flex-wrap:wrap;gap:.75rem 1.25rem;align-items:center}
.btn{display:inline-block;background:var(--tg);color:#fff;text-decoration:none;font:600 1rem ${SANS};padding:.8rem 1.4rem;border:0;border-radius:10px}
.btn:hover{filter:brightness(1.08)}
details{margin-top:1.75rem;padding-top:1.25rem;border-top:1px solid var(--line);color:var(--muted)}
summary{cursor:pointer;font-weight:600;color:var(--ink)}
details ul{padding-left:1.2rem;margin:.75rem 0 0}
details li{margin:.4rem 0}
footer{border-top:1px solid var(--line);margin-top:2.5rem;padding:1.5rem 0 3rem;color:var(--muted);font-size:.9375rem}
`;

export function renderPlanPage(o: PlanPageOptions): string {
  const bot = o.botUsername && /^[A-Za-z0-9_]{3,64}$/.test(o.botUsername) ? o.botUsername : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Plan a MUSD loan before you borrow - Tripwire</title>
<meta name="description" content="Choose how much BTC to deposit and how cautious to be. See what you would receive, how far BTC can fall before liquidation, and your place in the redemption queue, using Mezo's live loan terms.">
<meta name="theme-color" content="#18213a">
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top"><a class="brand" href="/">${MARK_SVG}Tripwire</a><nav><a href="/p">Check a loan</a>${bot ? `<a href="https://t.me/${esc(bot)}">Open the bot</a>` : ""}</nav></header>
<main>
<h1>Plan a loan before you borrow</h1>
<p class="lede">Choose how much BTC to deposit and how cautious to be. See what you would receive and how safe it is, using Mezo's live loan terms. Nothing here moves any money.</p>
<p id="status" class="msg" role="status">Loading today's loan terms…</p>

<div id="planner" hidden>
<section class="panel">
<label for="btc">BTC to deposit</label>
<div class="row"><input id="btc" type="text" inputmode="decimal" autocomplete="off" value="0.05" aria-describedby="usd"><span id="usd" class="hint"></span></div>

<label for="ratio">How cautious? <span class="hint">Collateral ratio: </span><strong id="ratioOut">160%</strong></label>
<input id="ratio" type="range" min="115" max="300" step="5" value="160">
<div class="chips" role="group" aria-label="Quick choices">
<button type="button" data-ratio="130">Aggressive 130%</button>
<button type="button" data-ratio="160">Balanced 160%</button>
<button type="button" data-ratio="200">Cautious 200%</button>
</div>

<span class="label">How wild do you expect BTC to be?</span>
<div class="chips" role="group" aria-label="Expected BTC volatility">
<button type="button" data-sigma="0.4" aria-pressed="false">Calm</button>
<button type="button" data-sigma="0.6" aria-pressed="true">Typical</button>
<button type="button" data-sigma="0.9" aria-pressed="false">Wild</button>
</div>
<span class="label">Over how long?</span>
<div class="chips" role="group" aria-label="Time window">
<button type="button" data-days="7" aria-pressed="false">7 days</button>
<button type="button" data-days="30" aria-pressed="true">30 days</button>
<button type="button" data-days="90" aria-pressed="false">90 days</button>
</div>
</section>

<section id="out" class="panel" aria-live="polite">
<p class="big">You would receive about <strong id="receive"></strong></p>
<p id="notice" class="notice" role="alert" hidden></p>
<dl class="stats">
<div><dt>Fee</dt><dd id="fee"></dd></div>
<div><dt>Total debt (with the 200 MUSD gas deposit)</dt><dd id="debt"></dd></div>
<div><dt>Liquidation price</dt><dd id="liq"></dd></div>
<div><dt>How far BTC can fall</dt><dd id="fall"></dd></div>
<div class="wide"><dt>Interest</dt><dd id="interest"></dd></div>
<div class="wide"><dt>Your place in today's redemption queue</dt><dd id="queue"></dd></div>
</dl>
<div class="verdict"><span id="grade" class="chip">Low</span><p id="chance"></p></div>
<div class="ruler" role="img" aria-label="Where your chosen ratio sits between liquidation at 110 percent and safe above 150 percent">
<div id="bar" class="bar"><div id="marker" class="marker"><span>your choice</span></div></div>
<div id="ticks" class="ticks"></div>
</div>
</section>

<section class="panel">
<h2>Compare your choices</h2>
<div class="scroll"><table>
<caption class="hint" style="text-align:left;caption-side:top">Same BTC, different caution levels</caption>
<thead><tr><th scope="col">Ratio</th><th scope="col">You'd receive</th><th scope="col">BTC can fall</th><th scope="col">Chance of liquidation</th><th scope="col">Queue place</th></tr></thead>
<tbody id="ladder"></tbody>
</table></div>
</section>

<section class="panel cta">
<a class="btn" href="${esc(o.appUrl)}">Borrow on Mezo</a>
${bot ? `<a href="https://t.me/${esc(bot)}">Then have Tripwire watch it</a>` : ""}
</section>

<details>
<summary>How these numbers work</summary>
<ul>
<li>The loan terms (fee, minimum loan, interest, and whether the system is in Recovery Mode) are read live from Mezo's contracts.</li>
<li>Your debt is what you borrow, plus the fee, plus a 200 MUSD gas deposit that Mezo adds to every loan. The ratio is your BTC's value divided by that total.</li>
<li>Liquidation happens when the ratio falls below 110%. Redemptions take the lowest-ratio loans first, paying debt down at $1 per MUSD.</li>
<li>The chance of liquidation is an estimate from a simple model: BTC moves randomly with the volatility you pick, with no trend, and the chance is that it touches your liquidation price at least once in the time window. Real crashes can be faster and deeper than this model, so treat it as a guide for comparing choices, not a promise.</li>
</ul>
</details>
</div>
</main>
<footer>Live data from Mezo testnet, read-only. Tripwire never asks for keys and cannot move funds. Not financial advice.</footer>
</div>
<script src="/assets/plan.js"></script>
</body>
</html>`;
}

export const PLAN_HEADERS = POSITION_HEADERS;
export const PLAN_SCRIPT_HEADERS = SCRIPT_HEADERS;

export function planPageResponse(o: PlanPageOptions): Response {
  return new Response(renderPlanPage(o), { status: 200, headers: PLAN_HEADERS });
}
export function planScriptResponse(): Response {
  return new Response(PLAN_JS, { status: 200, headers: PLAN_SCRIPT_HEADERS });
}
