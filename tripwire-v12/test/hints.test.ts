import { describe, expect, it } from "vitest";
import { hintsSummary } from "../src/api.js";
import { insertHints, nicrOf } from "../src/hints.js";
import { WAD } from "../src/risk.js";
import { buildView } from "../src/system.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const row = (n: number, coll: bigint, principal: bigint) => ({ address: `0x${n.toString(16).padStart(40, "0")}`, coll, principal });
// Nominal ratios (coll x 1e20 / principal): A highest, then B, then C.
const A = row(1, 3n * WAD, 1000n * WAD);
const B = row(2, 2n * WAD, 1000n * WAD);
const C = row(3, 1n * WAD, 1000n * WAD);

describe("insertHints", () => {
  it("finds the neighbours on each side, upper being the higher ratio", () => {
    expect(insertHints([A, B, C], nicrOf(25n * WAD / 10n, 1000n * WAD))).toEqual({ upper: A.address, lower: B.address });
  });
  it("handles the two ends of the list", () => {
    expect(insertHints([A, B, C], nicrOf(5n * WAD, 1000n * WAD))).toEqual({ upper: ZERO, lower: A.address }); // new head
    expect(insertHints([A, B, C], nicrOf(WAD / 2n, 1000n * WAD))).toEqual({ upper: C.address, lower: ZERO }); // new tail
    expect(insertHints([], 123n)).toEqual({ upper: ZERO, lower: ZERO });
  });
  it("leaves out the loan being adjusted, so it is not its own neighbour", () => {
    expect(insertHints([A, B, C], nicrOf(25n * WAD / 10n, 1000n * WAD), B.address)).toEqual({ upper: A.address, lower: C.address });
  });
  it("places an equal ratio after the existing one, and ignores loans with no principal", () => {
    expect(insertHints([A, B, C], nicrOf(2n * WAD, 1000n * WAD))).toEqual({ upper: B.address, lower: C.address });
    expect(insertHints([A, { ...B, principal: 0n }, C], nicrOf(25n * WAD / 10n, 1000n * WAD))).toEqual({ upper: A.address, lower: C.address });
  });
  it("is not confused by the order the rows arrive in", () => {
    expect(insertHints([C, A, B], nicrOf(25n * WAD / 10n, 1000n * WAD))).toEqual({ upper: A.address, lower: B.address });
  });
  it("uses Mezo's units: collateral x 1e20 / principal", () => {
    expect(nicrOf(WAD, 1000n * WAD)).toBe(10n ** 17n);
    expect(nicrOf(WAD, 0n)).toBe(0n);
  });
});

describe("hintsSummary", () => {
  const view = buildView({ price: 80_000n * WAD, stabilityPool: 0n, at: 0, troves: [A, B, C].map((r) => ({ ...r, debt: r.principal })) });
  it("answers from the saved picture of the protocol", () => {
    expect(hintsSummary(view, nicrOf(25n * WAD / 10n, 1000n * WAD).toString())).toEqual({ upper: A.address, lower: B.address });
    expect(hintsSummary(view, nicrOf(25n * WAD / 10n, 1000n * WAD).toString(), B.address)).toEqual({ upper: A.address, lower: C.address });
  });
  it("rejects malformed input instead of guessing", () => {
    for (const bad of ["", "abc", "-5", "1.5", "1e9", "9".repeat(41)]) expect(hintsSummary(view, bad)).toHaveProperty("error");
    expect(hintsSummary(view, "123", "nope")).toHaveProperty("error");
  });
});
