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

describe("@ravnexchange/sdk peer range", () => {
  // isPollingTerminal is re-exported from whichever sdk is installed: before 0.2.0 it stops on
  // "expired", and this package's once-a-minute expired polling would never run.
  it("requires an sdk that keeps polling past expired", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.peerDependencies["@ravnexchange/sdk"]).toBe(">=0.2.0");
  });
});
