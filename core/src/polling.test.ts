import { describe, expect, it } from "vitest";
import { isPollingTerminal } from "./polling";

describe("isPollingTerminal", () => {
  it("keeps polling while pending, processing or expired (a refund is due, not yet issued)", () => {
    expect(isPollingTerminal("pending")).toBe(false);
    expect(isPollingTerminal("processing")).toBe(false);
    expect(isPollingTerminal("expired")).toBe(false);
  });

  it("stops on every other status, including unknown", () => {
    for (const status of ["success", "refunded", "failed", "not_found", "unknown"] as const) {
      expect(isPollingTerminal(status)).toBe(true);
    }
  });
});
