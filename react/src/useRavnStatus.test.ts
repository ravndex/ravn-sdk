import { describe, expect, it } from "vitest";
import { RavnApiError } from "@ravnexchange/sdk";
import { isPermanentError, pollAgain } from "./useRavnStatus";

describe("isPermanentError", () => {
  it("treats UNAUTHORIZED, INVALID_REQUEST, QUOTE_INVALID, and NOT_FOUND as permanent", () => {
    for (const code of ["UNAUTHORIZED", "INVALID_REQUEST", "QUOTE_INVALID", "NOT_FOUND"]) {
      expect(isPermanentError(new RavnApiError(code, "x", undefined, undefined))).toBe(true);
    }
  });

  it("treats a transient code (RATE_LIMITED, INTERNAL) as not permanent, so polling keeps going", () => {
    expect(isPermanentError(new RavnApiError("RATE_LIMITED", "x", undefined, undefined))).toBe(false);
    expect(isPermanentError(new RavnApiError("INTERNAL", "x", undefined, undefined))).toBe(false);
  });

  it("treats a plain network error (not a RavnApiError) as not permanent", () => {
    expect(isPermanentError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isPermanentError(new Error("boom"))).toBe(false);
  });
});

describe("pollAgain", () => {
  it("polls until terminal, then once more after a success that carries a fee txHash", () => {
    expect(pollAgain("processing", undefined, false)).toBe(true);
    expect(pollAgain("success", undefined, false)).toBe(false);
    expect(pollAgain("success", "0xfee", false)).toBe(true);
    expect(pollAgain("success", "0xfee", true)).toBe(false);
    expect(pollAgain("refunded", "0xfee", false)).toBe(false);
  });
});
