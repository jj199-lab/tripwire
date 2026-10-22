import { defineChain, type Address } from "viem";

// Chain ID and RPC taken from mezo-org/musd (solidity/hardhat.config.ts).
// No process.env here on purpose: this file is shared with the Cloudflare Worker.
export const matsnet = defineChain({
  id: 31611,
  name: "Mezo Matsnet (testnet)",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.test.mezo.org"] } },
});

// Mainnet is left out on purpose. Add it from the Mezo docs if you ever need it.
export type NetworkName = "matsnet";

export interface Deployment {
  troveManager: Address;
  sortedTroves: Address;
  priceFeed: Address;
  stabilityPool: Address;
  borrowerOperations: Address;
  musd: Address;
}

// Addresses from mezo-org/musd solidity/artifacts/deployments/matsnet.
// Re-verify against the Mezo docs before relying on them.
export const DEPLOYMENTS: Record<NetworkName, Deployment> = {
  matsnet: {
    troveManager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
    sortedTroves: "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA",
    priceFeed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366",
    stabilityPool: "0x1CCA7E410eE41739792eA0A24e00349Dd247680e",
    borrowerOperations: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5",
    musd: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
  },
};

export const CHAINS = { matsnet } as const;
export const APP_URL = "https://testnet.mezo.org/borrow";
