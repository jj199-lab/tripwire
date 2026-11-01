import { formatUnits } from "viem";
import { stabilityPoolAbi, troveManagerAbi } from "./abi.js";
import type { NetworkName } from "./config.js";
import { pct, usd } from "./format.js";
import { MULTICALL3 } from "./multicall.js";
import { makeClient } from "./reader.js";
import { buildView, readSystem } from "./system.js";

const network: NetworkName = "matsnet";
const { client, deployment } = makeClient(network, { rpcUrl: process.env.MATSNET_RPC_URL || undefined });
const musd = (w: bigint) => Number(formatUnits(w, 18)).toLocaleString("en-US", { maximumFractionDigits: 0 });
const ok = (b: boolean) => (b ? "OK" : "MISMATCH, please tell Claude");

const code = await client.getCode({ address: MULTICALL3 });
console.log(`Multicall3 at ${MULTICALL3}: ${code && code !== "0x" ? "found" : "NOT FOUND, tell Claude"}`);
if (!code || code === "0x") process.exit(1);

const started = Date.now();
const raw = await readSystem(client, deployment, started);
const view = buildView(raw);
console.log(`Read ${view.troveCount} troves with Multicall in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

const [count, tcr, pool] = await Promise.all([
  client.readContract({ address: deployment.troveManager, abi: troveManagerAbi, functionName: "getTroveOwnersCount" }),
  client.readContract({ address: deployment.troveManager, abi: troveManagerAbi, functionName: "getTCR", args: [view.price] }),
  client.readContract({ address: deployment.stabilityPool, abi: stabilityPoolAbi, functionName: "getTotalMUSDDeposits" }),
]);

console.log(`BTC price            ${usd(view.price)}`);
console.log(`Troves               ${view.troveCount}   (contract says ${count})   ${ok(BigInt(view.troveCount) === count)}`);
const tcrDiff = Math.abs(Number(view.tcr - tcr)) / 1e16;
console.log(`System ratio         ${pct(view.tcr)}   (contract says ${pct(tcr)})   ${ok(tcrDiff < 0.5)}`);
console.log(`Stability Pool       ${musd(view.stabilityPool)} MUSD   (contract says ${musd(pool)})   ${ok(view.stabilityPool === pool)}`);
console.log(`Total debt           ${musd(view.totalDebt)} MUSD`);
console.log(`In redemption queue  ${view.redeemableCount} (loans below 110% are skipped)\n`);
console.log("First in line to be redeemed:");
for (const e of view.queue.slice(0, 5)) {
  console.log(`  #${e.rank}  ${e.address.slice(0, 8)}…${e.address.slice(-4)}  ratio ${(Number(e.coll * view.price / e.debt) / 1e16).toFixed(1)}%  debt ${musd(e.debt)} MUSD  ahead ${musd(e.musdAhead)} MUSD`);
}
