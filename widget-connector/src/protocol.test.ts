import { describe, expect, it, vi } from "vitest";
import { isBridgeEnvelope, makeEnvelope, warnOnVersionMismatch, BRIDGE_SOURCE, BRIDGE_VERSION } from "./protocol";

describe("makeEnvelope / isBridgeEnvelope", () => {
  it("round-trips through the envelope shape", () => {
    const envelope = makeEnvelope("wallet:connected", { address: "0xabc", chainId: 1 }, "id-1");

    expect(envelope).toEqual({
      source: BRIDGE_SOURCE,
      version: BRIDGE_VERSION,
      id: "id-1",
      type: "wallet:connected",
      payload: { address: "0xabc", chainId: 1 },
    });
    expect(isBridgeEnvelope(envelope)).toBe(true);
  });

  it("rejects postMessage traffic that isn't ours", () => {
    expect(isBridgeEnvelope({ some: "extension payload" })).toBe(false);
    expect(isBridgeEnvelope("a string, not an object")).toBe(false);
    expect(isBridgeEnvelope(null)).toBe(false);
    expect(isBridgeEnvelope({ source: "some-other-lib", id: "1", type: "x" })).toBe(false);
  });

  it("rejects a version mismatch instead of silently misparsing it", () => {
    expect(isBridgeEnvelope({ source: BRIDGE_SOURCE, version: "2", id: "1", type: "x" })).toBe(false);
  });
});

describe("warnOnVersionMismatch", () => {
  it("warns when the data is clearly ours but on a different protocol version", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnOnVersionMismatch({ source: BRIDGE_SOURCE, version: "2", id: "1", type: "x" });

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("stays silent for our own current-version envelopes and for unrelated data", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnOnVersionMismatch(makeEnvelope("wallet:connected", {}, "id-1"));
    warnOnVersionMismatch({ some: "extension payload" });
    warnOnVersionMismatch(null);
    warnOnVersionMismatch("not an object");

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
