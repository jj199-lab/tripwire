import { getAddress, isAddress, type Address } from "viem";

/** Accepts lower, upper or checksummed 0x addresses. Returns the checksummed form, or null. */
export function parseAddress(input: string): Address | null {
  const trimmed = input.trim();
  if (!isAddress(trimmed, { strict: false })) return null;
  return getAddress(trimmed);
}
