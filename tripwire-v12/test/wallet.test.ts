import { runInNewContext } from "node:vm";
import { encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { PLAN_JS } from "../src/pages/plan.js";
import { WALLET_JS } from "../src/pages/wallet.js";

const sandbox: Record<string, any> = {};
runInNewContext(WALLET_JS, sandbox);
const w = sandbox.__wallet;

const abi = parseAbi([
  "function openTrove(uint256 _debtAmount, address _upperHint, address _lowerHint) payable",
  "function addColl(address _upperHint, address _lowerHint) payable",
  "function repayMUSD(uint256 _amount, address _upperHint, address _lowerHint)",
]);
const E18 = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000";
const TO = "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5";

let seed = 777;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const randAddr = () => `0x${Array.from({ length: 40 }, () => Math.floor(rnd() * 16).toString(16)).join("")}`;
const randWei = () => BigInt(Math.floor(rnd() * 1e15)) * BigInt(Math.floor(rnd() * 1e6) + 1) * 1000n;

describe("wallet script: encoding", () => {
  it("uses the real function selectors of Mezo's BorrowerOperations", () => {
    expect(w.SELECTOR.openTrove).toBe(toFunctionSelector("openTrove(uint256,address,address)").slice(2));
    expect(w.SELECTOR.addColl).toBe(toFunctionSelector("addColl(address,address)").slice(2));
    expect(w.SELECTOR.repayMUSD).toBe(toFunctionSelector("repayMUSD(uint256,address,address)").slice(2));
  });

  it("encodes openTrove byte for byte like viem, across many random inputs", () => {
    for (let i = 0; i < 80; i++) {
      const debt = randWei(), coll = randWei(), up = randAddr(), lo = randAddr();
      const tx = w.buildOpenTrove(TO, debt, coll, { upper: up, lower: lo });
      expect(tx.data).toBe(encodeFunctionData({ abi, functionName: "openTrove", args: [debt, up as `0x${string}`, lo as `0x${string}`] }));
      expect(tx.value).toBe("0x" + coll.toString(16));
      expect(tx.to).toBe(TO);
    }
  });

  it("encodes addColl and repayMUSD byte for byte like viem", () => {
    for (let i = 0; i < 80; i++) {
      const coll = randWei(), amt = randWei(), up = randAddr(), lo = randAddr();
      expect(w.buildAddColl(TO, coll, { upper: up, lower: lo }).data).toBe(encodeFunctionData({ abi, functionName: "addColl", args: [up as `0x${string}`, lo as `0x${string}`] }));
      expect(w.buildAddColl(TO, coll, { upper: up, lower: lo }).value).toBe("0x" + coll.toString(16));
      const r = w.buildRepay(TO, amt, { upper: up, lower: lo });
      expect(r.data).toBe(encodeFunctionData({ abi, functionName: "repayMUSD", args: [amt, up as `0x${string}`, lo as `0x${string}`] }));
      expect(r.value).toBe("0x0"); // repaying sends no BTC
    }
  });

  it("uses the zero address when there are no hints, and rejects anything that is not an address", () => {
    expect(w.buildOpenTrove(TO, E18, E18, {}).data).toBe(encodeFunctionData({ abi, functionName: "openTrove", args: [E18, ZERO, ZERO] }));
    expect(w.buildAddColl(TO, E18).data).toBe(encodeFunctionData({ abi, functionName: "addColl", args: [ZERO, ZERO] }));
    expect(() => w.buildAddColl(TO, E18, { upper: "0x123", lower: ZERO })).toThrow(/bad address/);
    expect(() => w.buildRepay(TO, -1n, {})).toThrow(/negative/);
  });
});

describe("wallet script: numbers", () => {
  it("reads decimal text exactly, with no floating-point error", () => {
    expect(w.toWei("0.05")).toBe(5n * 10n ** 16n);
    expect(w.toWei("1")).toBe(E18);
    expect(w.toWei("0,05")).toBe(5n * 10n ** 16n);
    expect(w.toWei(".5")).toBe(E18 / 2n);
    expect(w.toWei("0.123456789012345678")).toBe(123456789012345678n);
    expect(w.toWei("0.1234567890123456789999")).toBe(123456789012345678n); // extra digits are dropped, not rounded up
    for (const bad of ["", ".", "abc", "-1", "1e5", "1.2.3", "0x10"]) expect(w.toWei(bad)).toBe(0n);
  });

  it("formats amounts back for people", () => {
    expect(w.fromWei(5n * 10n ** 16n, 6)).toBe("0.05");
    expect(w.fromWei(E18, 6)).toBe("1");
    expect(w.fromWei(2297702297702297702297n, 2)).toBe("2297.7");
    expect(w.fromWei(w.toWei("0.123456"), 18)).toBe("0.123456");
  });

  it("prepares the price and fee as 18-decimal numbers", () => {
    expect(w.priceToWei(81031.5)).toBe(81031500000n * 10n ** 12n);
    expect(w.feePctToWei(0.1)).toBe(10n ** 15n);
    expect(w.feePctToWei(0)).toBe(0n);
  });
});

describe("wallet script: how much to borrow", () => {
  const base = { collWei: 5n * 10n ** 16n, ratioPct: 160, priceWei: 80_000n * E18, feeWei: 10n ** 15n, gasWei: 200n * E18 };

  it("follows Mezo's openTrove: fee on the amount borrowed, 200 MUSD gas deposit added to the debt", () => {
    const r = w.openLoanAmounts(base);
    // 0.05 BTC x $80,000 / 1.6 = 2,500 total debt; less the 200 gas deposit = 2,300; amount borrowed = 2,300 / 1.001, rounded down
    expect(r.debtWei).toBe((2_300n * E18 * E18) / (E18 + 10n ** 15n));
    expect(r.feeWei).toBe((r.debtWei * 10n ** 15n) / E18);
    expect(r.compositeWei).toBe(r.debtWei + r.feeWei + 200n * E18);
    expect(2_500n * E18 - r.compositeWei).toBeLessThan(10n ** 12n); // within a trillionth of a MUSD of the target
    expect(r.compositeWei).toBeLessThanOrEqual(2_500n * E18); // rounded down, never up
  });

  it("never lands below the ratio that was asked for", () => {
    for (const ratio of [111, 125, 160, 175, 200, 300]) {
      for (const coll of [3n * 10n ** 16n, 5n * 10n ** 16n, 123456789n * 10n ** 9n, E18]) {
        const r = w.openLoanAmounts({ ...base, collWei: coll, ratioPct: ratio });
        if (r.debtWei === 0n) continue;
        const actual = (coll * base.priceWei * 100n) / E18 / r.compositeWei; // whole percent, rounded down
        expect(actual).toBeGreaterThanOrEqual(BigInt(ratio));
      }
    }
  });

  it("charges no fee in Recovery Mode", () => {
    const r = w.openLoanAmounts({ ...base, feeWei: 0n });
    expect(r.debtWei).toBe(2_300n * E18);
    expect(r.feeWei).toBe(0n);
  });

  it("returns nothing to borrow when the gas deposit alone would use up the debt", () => {
    expect(w.openLoanAmounts({ ...base, collWei: 10n ** 15n }).debtWei).toBe(0n);
  });

  it("agrees with the planner page's own numbers", () => {
    const planBox: Record<string, any> = {};
    runInNewContext(PLAN_JS, planBox);
    const t = { price: 80_000, recovery: false, feePct: 0.1, minLoan: 1800, gas: 200, interestPct: 1, liqPct: 110, ccrPct: 150, totalColl: 100, totalDebt: 4_000_000, queue: [] };
    const shown = planBox.__plan.plan(0.05, 160, t).receive; // what the planner tells the person they will receive
    const sent = Number(w.openLoanAmounts(base).debtWei) / 1e18; // what the wallet will actually ask for
    expect(sent).toBeCloseTo(shown, 6);
  });

  it("works out the nominal ratio Mezo sorts by (collateral x 1e20 / principal)", () => {
    expect(w.nicr(E18, 1000n * E18)).toBe(10n ** 17n);
    expect(w.nicr(E18, 0n)).toBe(0n);
  });
});

describe("wallet script: error messages", () => {
  it("turns each failure into a clear sentence", () => {
    expect(w.friendlyError({ code: "NO_WALLET" })).toMatch(/No wallet/);
    expect(w.friendlyError({ code: 4001 })).toMatch(/declined/);
    expect(w.friendlyError({ code: "ACTION_REJECTED" })).toMatch(/declined/);
    expect(w.friendlyError({ code: -32002 })).toMatch(/already has a request/);
    expect(w.friendlyError({ code: "WRONG_CHAIN" })).toMatch(/Mezo testnet/);
    expect(w.friendlyError({ message: "insufficient funds for gas * price + value" })).toMatch(/enough BTC/);
    expect(w.friendlyError({ message: "execution reverted: BorrowerOps: ICR is below MCR" })).toMatch(/Mezo would reject/);
    expect(w.friendlyError({ message: "cannot estimate gas; transaction may fail" })).toMatch(/Mezo would reject/);
    expect(w.friendlyError(w.inputError("Enter how much BTC to add."))).toBe("Enter how much BTC to add."); // our own checks read as written
    expect(w.friendlyError(new Error("boom"))).toContain("boom");
    expect(w.friendlyError(undefined)).toMatch(/unknown error/);
  });
});

// A pretend wallet that records every request it is asked to handle.
function fakeProvider(handlers: Record<string, (params: any) => any>) {
  const calls: Array<{ method: string; params: any }> = [];
  return {
    calls,
    async request({ method, params }: { method: string; params?: any }) {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw Object.assign(new Error(`unexpected ${method}`), { code: -32601 });
      return h(params);
    },
  };
}
const rejection = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
const noSleep = async () => {};

describe("wallet script: talking to a wallet", () => {
  it("connects and returns the first account, or fails clearly", async () => {
    const p = fakeProvider({ eth_requestAccounts: () => ["0xabc0000000000000000000000000000000000001"] });
    expect(await w.makeWallet(() => p, noSleep).connect()).toBe("0xabc0000000000000000000000000000000000001");
    await expect(w.makeWallet(() => fakeProvider({ eth_requestAccounts: () => [] }), noSleep).connect()).rejects.toThrow(/No account/);
    await expect(w.makeWallet(() => undefined, noSleep).connect()).rejects.toMatchObject({ code: "NO_WALLET" });
    expect(w.makeWallet(() => undefined, noSleep).hasWallet()).toBe(false);
    expect(w.makeWallet(() => p, noSleep).hasWallet()).toBe(true);
  });

  it("leaves the network alone when the wallet is already on Mezo testnet", async () => {
    const p = fakeProvider({ eth_chainId: () => "0x7b7b" });
    await w.makeWallet(() => p, noSleep).ensureChain();
    expect(p.calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });

  it("switches networks when it can, and adds Mezo testnet when the wallet has never heard of it", async () => {
    let chain = "0x1";
    const switching = fakeProvider({ eth_chainId: () => chain, wallet_switchEthereumChain: () => { chain = "0x7b7b"; return null; } });
    await w.makeWallet(() => switching, noSleep).ensureChain();
    expect(switching.calls.map((c) => c.method)).toEqual(["eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]);
    expect(switching.calls[1]!.params).toEqual([{ chainId: "0x7b7b" }]);

    chain = "0x1";
    const adding = fakeProvider({
      eth_chainId: () => chain,
      wallet_switchEthereumChain: () => { throw Object.assign(new Error("Unrecognized chain"), { code: 4902 }); },
      wallet_addEthereumChain: () => { chain = "0x7b7b"; return null; },
    });
    await w.makeWallet(() => adding, noSleep).ensureChain();
    const add = adding.calls.find((c) => c.method === "wallet_addEthereumChain")!;
    expect(add.params[0]).toMatchObject({ chainId: "0x7b7b", chainName: "Mezo Testnet", rpcUrls: ["https://rpc.test.mezo.org"], nativeCurrency: { symbol: "BTC", decimals: 18 } });
  });

  it("fails clearly when the person stays on another network, and passes on a refusal", async () => {
    const stuck = fakeProvider({ eth_chainId: () => "0x1", wallet_switchEthereumChain: () => null });
    await expect(w.makeWallet(() => stuck, noSleep).ensureChain()).rejects.toMatchObject({ code: "WRONG_CHAIN" });
    const refusing = fakeProvider({ eth_chainId: () => "0x1", wallet_switchEthereumChain: () => { throw rejection(); } });
    await expect(w.makeWallet(() => refusing, noSleep).ensureChain()).rejects.toMatchObject({ code: 4001 });
  });

  it("asks the network to simulate the transaction first, then sends exactly the same thing", async () => {
    const tx = w.buildAddColl(TO, 5n * 10n ** 16n, {});
    const p = fakeProvider({ eth_estimateGas: () => "0x30000", eth_sendTransaction: () => "0xhash" });
    const hash = await w.makeWallet(() => p, noSleep).send("0xfrom", tx);
    expect(hash).toBe("0xhash");
    expect(p.calls.map((c) => c.method)).toEqual(["eth_estimateGas", "eth_sendTransaction"]);
    expect(p.calls[1]!.params[0]).toEqual({ from: "0xfrom", to: TO, data: tx.data, value: tx.value });
    expect(p.calls[0]!.params[0]).toEqual(p.calls[1]!.params[0]);
  });

  it("never sends a transaction that the simulation says would fail", async () => {
    const p = fakeProvider({ eth_estimateGas: () => { throw new Error("execution reverted: ICR below MCR"); }, eth_sendTransaction: () => "0xhash" });
    await expect(w.makeWallet(() => p, noSleep).send("0xfrom", w.buildRepay(TO, E18, {}))).rejects.toThrow(/reverted/);
    expect(p.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
  });

  it("waits for the receipt, and reports success, failure and a timeout", async () => {
    let polls = 0;
    const ok = fakeProvider({ eth_getTransactionReceipt: () => (++polls < 3 ? null : { status: "0x1", blockNumber: "0x10" }) });
    expect(await w.makeWallet(() => ok, noSleep).waitForReceipt("0xh")).toMatchObject({ ok: true });
    expect(polls).toBe(3);
    const failed = fakeProvider({ eth_getTransactionReceipt: () => ({ status: "0x0" }) });
    expect(await w.makeWallet(() => failed, noSleep).waitForReceipt("0xh")).toMatchObject({ ok: false });
    const never = fakeProvider({ eth_getTransactionReceipt: () => null });
    expect(await w.makeWallet(() => never, noSleep).waitForReceipt("0xh", 30)).toMatchObject({ ok: false, timedOut: true });
  });

  it("builds explorer links", () => {
    expect(w.explorerTx("0xabc")).toBe("https://explorer.test.mezo.org/tx/0xabc");
    expect(w.CHAIN_ID).toBe(31611);
  });
});

describe("wallet script: safety", () => {
  it("never touches keys, storage or the network by itself, and builds no HTML", () => {
    expect(WALLET_JS).not.toMatch(/privateKey|private_key|mnemonic|seed phrase|personal_sign|eth_sign|eth_signTypedData|localStorage|sessionStorage|document\.cookie|innerHTML|eval\(|new Function/i);
  });
});
