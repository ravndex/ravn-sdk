import { describe, expect, it } from "vitest";
import { isPollingTerminal, msUntilExpiry } from "./polling";

describe("msUntilExpiry", () => {
  it("returns the remaining time", () => {
    expect(msUntilExpiry(10_000, 4_000)).toBe(6_000);
  });

  it("clamps to 0 once past expiry, never negative", () => {
    expect(msUntilExpiry(1_000, 5_000)).toBe(0);
  });
});

describe("isPollingTerminal", () => {
  it("keeps polling while pending or processing", () => {
    expect(isPollingTerminal("pending")).toBe(false);
    expect(isPollingTerminal("processing")).toBe(false);
  });

  it("stops on every other status, including unknown", () => {
    for (const status of ["success", "refunded", "failed", "expired", "not_found", "unknown"] as const) {
      expect(isPollingTerminal(status)).toBe(true);
    }
  });
});
