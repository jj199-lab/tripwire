/**
 * Browser script that lets a person act on Mezo from their OWN wallet: open a loan, add collateral, repay.
 * Tripwire only builds the transaction. The wallet shows it and the person approves it. Keys never leave the wallet.
 *
 * The encoders are tiny and hand-written for exactly three functions of Mezo's BorrowerOperations:
 *   openTrove(uint256 _debtAmount, address _upperHint, address _lowerHint) payable
 *   addColl(address _upperHint, address _lowerHint) payable
 *   repayMUSD(uint256 _amount, address _upperHint, address _lowerHint)
 * The tests check every byte against viem's own encoder. Keep `${` and backticks out of this file's script.
 */
export const WALLET_JS = String.raw`(function () {
  "use strict";

  var CHAIN_ID = 31611;
  var CHAIN = {
    chainId: "0x7b7b",
    chainName: "Mezo Testnet",
    nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
    rpcUrls: ["https://rpc.test.mezo.org"],
    blockExplorerUrls: ["https://explorer.test.mezo.org"]
  };
  var EXPLORER = "https://explorer.test.mezo.org";
  var SELECTOR = { openTrove: "2f3a6d98", addColl: "68647db1", repayMUSD: "dc283bb3" };
  var ZERO = "0x0000000000000000000000000000000000000000";
  var E18 = 1000000000000000000n;
  var NICR_PRECISION = 100000000000000000000n;

  // ---- numbers ----
  function toWei(text) {
    var s = String(text).trim().replace(",", ".");
    if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
    var parts = s.split(".");
    var frac = (parts[1] || "").slice(0, 18);
    while (frac.length < 18) frac += "0";
    return BigInt(parts[0] || "0") * E18 + BigInt(frac);
  }

  function fromWei(w, maxDecimals) {
    var neg = w < 0n;
    var abs = neg ? -w : w;
    var whole = (abs / E18).toString();
    var frac = (abs % E18).toString().padStart(18, "0").slice(0, maxDecimals);
    frac = frac.replace(/0+$/, "");
    return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
  }

  function priceToWei(usd) { return BigInt(Math.round(usd * 1000000)) * 1000000000000n; }
  function feePctToWei(pct) { return BigInt(Math.round(pct * 1000000)) * 10000000000n; }
  function nicr(collWei, principalWei) { return principalWei > 0n ? (collWei * NICR_PRECISION) / principalWei : 0n; }

  // What openTrove will do with these inputs: the fee is charged on the amount borrowed, a gas deposit is added to
  // the debt, and the loan's ratio is its collateral value over that total. The borrowed amount is rounded DOWN so
  // the real ratio can only come out equal or higher than the one asked for.
  function openLoanAmounts(o) {
    var value = (o.collWei * o.priceWei) / E18;
    var composite = (value * 100n) / BigInt(o.ratioPct);
    var net = composite - o.gasWei;
    if (net <= 0n) return { debtWei: 0n, feeWei: 0n, compositeWei: composite, nicr: 0n };
    var debt = (net * E18) / (E18 + o.feeWei);
    var fee = (debt * o.feeWei) / E18;
    var total = debt + fee + o.gasWei;
    return { debtWei: debt, feeWei: fee, compositeWei: total, nicr: nicr(o.collWei, total) };
  }

  // ---- encoding ----
  function isAddress(a) { return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a); }
  function word(hexNoPrefix) { return hexNoPrefix.padStart(64, "0"); }
  function hex(n) { return "0x" + BigInt(n).toString(16); }

  function encUint(v) {
    var n = BigInt(v);
    if (n < 0n) throw new Error("negative amount");
    return word(n.toString(16));
  }

  function encAddr(a) {
    if (a === undefined || a === null || a === "") a = ZERO;
    if (!isAddress(a)) throw new Error("bad address");
    return word(a.slice(2).toLowerCase());
  }

  function buildOpenTrove(to, debtWei, collWei, hints) {
    var h = hints || {};
    return { to: to, data: "0x" + SELECTOR.openTrove + encUint(debtWei) + encAddr(h.upper) + encAddr(h.lower), value: hex(collWei) };
  }
  function buildAddColl(to, collWei, hints) {
    var h = hints || {};
    return { to: to, data: "0x" + SELECTOR.addColl + encAddr(h.upper) + encAddr(h.lower), value: hex(collWei) };
  }
  function buildRepay(to, amountWei, hints) {
    var h = hints || {};
    return { to: to, data: "0x" + SELECTOR.repayMUSD + encUint(amountWei) + encAddr(h.upper) + encAddr(h.lower), value: "0x0" };
  }

  function explorerTx(hash) { return EXPLORER + "/tx/" + hash; }

  // A problem with what the person typed or chose: shown exactly as written.
  function inputError(message) {
    var err = new Error(message);
    err.code = "INPUT";
    return err;
  }

  function friendlyError(e) {
    var code = e && e.code;
    var msg = String((e && (e.shortMessage || e.message)) || "");
    if (code === "INPUT") return String(e.message);
    if (code === "NO_WALLET") return "No wallet was found in this browser. Open this page in a browser with a wallet such as MetaMask, or in your wallet app's built-in browser.";
    if (code === 4001 || code === "ACTION_REJECTED") return "You declined it in your wallet, so nothing was sent.";
    if (code === -32002) return "Your wallet already has a request waiting. Open it and approve or reject it first.";
    if (code === "WRONG_CHAIN") return "Please switch your wallet to the Mezo testnet and try again.";
    if (/insufficient funds/i.test(msg)) return "Your wallet doesn't have enough BTC for this and the network fee.";
    if (/revert|execution|gas required exceeds|cannot estimate|always failing|invalid opcode/i.test(msg)) {
      return "Mezo would reject this transaction, so nothing was sent. Common reasons: the ratio is too low, the loan is below the minimum, or the price moved. Try a more cautious choice.";
    }
    return "Something went wrong: " + (msg ? msg.slice(0, 140) : "unknown error") + ".";
  }

  // ---- talking to the person's wallet (an EIP-1193 provider) ----
  function makeWallet(getProvider, sleep) {
    var wait = sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    function provider() {
      var p = getProvider();
      if (!p || typeof p.request !== "function") {
        var err = new Error("No wallet");
        err.code = "NO_WALLET";
        throw err;
      }
      return p;
    }

    async function connect() {
      var accounts = await provider().request({ method: "eth_requestAccounts" });
      if (!accounts || !accounts.length) throw new Error("No account was shared.");
      return accounts[0];
    }

    async function chainId() {
      return parseInt(await provider().request({ method: "eth_chainId" }), 16);
    }

    async function ensureChain() {
      if ((await chainId()) === CHAIN_ID) return;
      try {
        await provider().request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.chainId }] });
      } catch (e) {
        if (e && (e.code === 4902 || e.code === -32603)) {
          await provider().request({ method: "wallet_addEthereumChain", params: [CHAIN] });
        } else {
          throw e;
        }
      }
      if ((await chainId()) !== CHAIN_ID) {
        var err = new Error("Wrong network");
        err.code = "WRONG_CHAIN";
        throw err;
      }
    }

    // Asks the network to run the transaction first. If it would fail, this throws and nothing is sent.
    async function send(from, tx) {
      var params = { from: from, to: tx.to, data: tx.data, value: tx.value || "0x0" };
      await provider().request({ method: "eth_estimateGas", params: [params] });
      return provider().request({ method: "eth_sendTransaction", params: [params] });
    }

    async function waitForReceipt(hash, timeoutMs) {
      var deadline = Date.now() + (timeoutMs || 180000);
      while (Date.now() < deadline) {
        var receipt = await provider().request({ method: "eth_getTransactionReceipt", params: [hash] });
        if (receipt) return { ok: receipt.status === "0x1", receipt: receipt };
        await wait(2500);
      }
      return { ok: false, timedOut: true };
    }

    return { connect: connect, chainId: chainId, ensureChain: ensureChain, send: send, waitForReceipt: waitForReceipt, hasWallet: function () { var p = getProvider(); return !!(p && typeof p.request === "function"); } };
  }

  var pure = {
    CHAIN_ID: CHAIN_ID, CHAIN: CHAIN, SELECTOR: SELECTOR, toWei: toWei, fromWei: fromWei, priceToWei: priceToWei, feePctToWei: feePctToWei,
    nicr: nicr, openLoanAmounts: openLoanAmounts, buildOpenTrove: buildOpenTrove, buildAddColl: buildAddColl, buildRepay: buildRepay,
    explorerTx: explorerTx, inputError: inputError, friendlyError: friendlyError, isAddress: isAddress, makeWallet: makeWallet
  };

  if (typeof window === "undefined") {
    globalThis.__wallet = pure;
    return;
  }

  // Where in Mezo's sorted list the loan belongs. Only a speed-up: the contract checks it, and the zero address is always allowed.
  pure.getHints = function (nicrWei, exclude) {
    var url = "/api/hints?nicr=" + encodeURIComponent(nicrWei.toString()) + (exclude ? "&exclude=" + encodeURIComponent(exclude) : "");
    return fetch(url, { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { return j && j.upper ? { upper: j.upper, lower: j.lower } : {}; })
      .catch(function () { return {}; });
  };

  var live = makeWallet(function () { return window.ethereum; });
  for (var k in pure) { if (Object.prototype.hasOwnProperty.call(pure, k)) live[k] = pure[k]; }
  window.TripwireWallet = live;
})();
`;

export const WALLET_SCRIPT_HEADERS: Record<string, string> = {
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff",
};

export function walletScriptResponse(): Response {
  return new Response(WALLET_JS, { status: 200, headers: WALLET_SCRIPT_HEADERS });
}
