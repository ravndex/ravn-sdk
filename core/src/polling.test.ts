import { describe, expect, it } from "vitest";
import { isPollingTerminal } from "./polling";

describe("isPollingTerminal", () => {
  it("keeps polling while pending, processing, expired (a refund is due) or not_found (the venue hasn't seen it yet)", () => {
    expect(isPollingTerminal("pending")).toBe(false);
    expect(isPollingTerminal("processing")).toBe(false);
    expect(isPollingTerminal("expired")).toBe(false);
    expect(isPollingTerminal("not_found")).toBe(false);
  });

  it("stops on success, refunded, failed and unknown (no tracker: it never changes)", () => {
    for (const status of ["success", "refunded", "failed", "unknown"] as const) {
      expect(isPollingTerminal(status)).toBe(true);
    }
  });
});
