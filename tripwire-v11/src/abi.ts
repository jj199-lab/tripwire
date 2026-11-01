import { parseAbi } from "viem";

// Signatures copied from mezo-org/musd solidity/contracts/interfaces.
export const troveManagerAbi = parseAbi([
  "function getTroveStatus(address _borrower) view returns (uint8)",
  "function getCurrentICR(address _borrower, uint256 _price) view returns (uint256)",
  "function getEntireDebtAndColl(address _borrower) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)",
  "function getTCR(uint256 _price) view returns (uint256)",
  "function checkRecoveryMode(uint256 _price) view returns (bool)",
  "function getTroveOwnersCount() view returns (uint256)",
]);

export const stabilityPoolAbi = parseAbi(["function getTotalMUSDDeposits() view returns (uint256)"]);

export const sortedTrovesAbi = parseAbi([
  "function getSize() view returns (uint256)",
  "function getLast() view returns (address)",
  "function getPrev(address _id) view returns (address)",
  "function contains(address _id) view returns (bool)",
]);

export const priceFeedAbi = parseAbi(["function fetchPrice() view returns (uint256)"]);

// TroveManager.Status enum: nonExistent, active, closedByOwner, closedByLiquidation, closedByRedemption
export const TROVE_ACTIVE = 1;
