import { isAddress, type Address } from "viem";
import { APP_URL, type NetworkName } from "./config.js";
import { formatStatus, pct } from "./format.js";
import { makeClient, readPosition as readPositionDirect, readRedemptionRank } from "./reader.js";
import { MemoryCache, ViewLoader } from "./viewloader.js";

const args = process.argv.slice(2);
const netFlag = args.indexOf("--network");
const network = (netFlag >= 0 ? args[netFlag + 1] : "matsnet") as NetworkName;
const address = args.find((a) => a.startsWith("0x"));

if (!address || !isAddress(address, { strict: false })) {
  console.error("Usage: npm run check -- <0xAddress> [--network matsnet]");
  process.exit(1);
}

const { client, deployment } = makeClient(network, { rpcUrl: process.env.MATSNET_RPC_URL || undefined });

// Main path: the same engine the bot uses (Multicall snapshot).
const view = await new ViewLoader({ client, deployment, cache: new MemoryCache() }).load([address]);
const snap = view.position(address);
if (!snap) {
  console.log("No active trove for this address on", network);
  process.exit(0);
}
console.log(formatStatus(snap, view.rank(address), APP_URL));

// Independent cross-check straight from the contracts, one call at a time.
const direct = await readPositionDirect(client, deployment, address as Address);
if (direct) {
  const walk = await readRedemptionRank(client, deployment, address as Address);
  const walkText = walk && !("truncated" in walk) ? `${walk.rank} of ${walk.size}` : "n/a";
  const same = direct.icr === snap.icr || Math.abs(Number(direct.icr - snap.icr)) < 1e12;
  console.log(
    `\nCross-check: ratio from the contract ${pct(direct.icr)}, from the snapshot ${pct(snap.icr)} ${same ? "(match)" : "(DIFFERENT, please tell Claude)"}`,
  );
  console.log(`Queue position by walking the contract's list: ${walkText} (the bot's number skips loans already below 110%)`);
}
