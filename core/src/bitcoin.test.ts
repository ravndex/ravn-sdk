import { describe, expect, it, vi } from "vitest";
import { satsConnectHandlers, unisatHandlers } from "./bitcoin";
import type { SatsConnectRequest, UnisatLike } from "./bitcoin";
import { SentUnclearError } from "./execute-and-track";

// A real PSBT RAVN built (guard.fixtures.json "-1 psbt btc->base near_intents"): one input, the user's.
const USER = "bc1qj2qrg8qrpnpw70cd99z90j6h0pzhscgmt0c78g";
const PSBT =
  "cHNidP8BAHECAAAAAar0rM2w7nRC2COY9EfB9jQObDxwh0jruMKJGX1+eTV/AQAAAAD/////AkANAwAAAAAAFgAUkJNwyVqpjTIYqlffuS6OZcDim3HfKQYAAAAAABYAFJKANBwDDMLvPw0pRFfLV3hFeGEbAAAAAAABAR+sNwkAAAAAABYAFJKANBwDDMLvPw0pRFfLV3hFeGEbAAAA";
const OTHER = "bc1qhne88dzltx85lhvc56888hslfxntrjxdrvh3y8";

describe("satsConnectHandlers", () => {
  it("asks the wallet to sign the user's inputs and broadcast, and returns the txid", async () => {
    const request = vi.fn<SatsConnectRequest>(async () => ({ status: "success", result: { psbt: "signed", txid: "btc-txid" } }));
    await expect(satsConnectHandlers(request, USER).sendBitcoinPsbt!(PSBT)).resolves.toBe("btc-txid");
    expect(request).toHaveBeenCalledWith("signPsbt", { psbt: PSBT, signInputs: { [USER]: [0] }, broadcast: true });
  });

  it("refuses, asking nothing of the wallet, a PSBT that spends another address's coins", async () => {
    const request = vi.fn<SatsConnectRequest>();
    await expect(satsConnectHandlers(request, OTHER).sendBitcoinPsbt!(PSBT)).rejects.toThrow(/aren't this wallet's/);
    expect(request).not.toHaveBeenCalled();
  });

  it("says nothing was sent on a refusal before signing, and that it may be out on anything else", async () => {
    const refused: SatsConnectRequest = async () => ({ status: "error", error: { code: -32000, message: "User rejected" } });
    const error = await satsConnectHandlers(refused, USER).sendBitcoinPsbt!(PSBT).catch((e) => e);
    expect(error).not.toBeInstanceOf(SentUnclearError);
    expect(error.message).toMatch(/nothing was sent/);

    const broke: SatsConnectRequest = async () => ({ status: "error", error: { code: -32603, message: "push failed" } });
    await expect(satsConnectHandlers(broke, USER).sendBitcoinPsbt!(PSBT)).rejects.toBeInstanceOf(SentUnclearError);
    const noTxid: SatsConnectRequest = async () => ({ status: "success", result: { psbt: "signed" } });
    await expect(satsConnectHandlers(noTxid, USER).sendBitcoinPsbt!(PSBT)).rejects.toBeInstanceOf(SentUnclearError);
  });
});

describe("unisatHandlers", () => {
  const hex = Buffer.from(PSBT, "base64").toString("hex");

  it("signs the PSBT as hex, finalized, then broadcasts it", async () => {
    const unisat: UnisatLike = { signPsbt: vi.fn(async () => "signedhex"), pushPsbt: vi.fn(async () => "btc-txid") };
    await expect(unisatHandlers(unisat, USER).sendBitcoinPsbt!(PSBT)).resolves.toBe("btc-txid");
    expect(unisat.signPsbt).toHaveBeenCalledWith(hex, { autoFinalized: true, toSignInputs: [{ index: 0, address: USER }] });
    expect(unisat.pushPsbt).toHaveBeenCalledWith("signedhex");
  });

  it("a refused signature: nothing sent; a failed broadcast: it may be out", async () => {
    const refused: UnisatLike = { signPsbt: async () => Promise.reject(Object.assign(new Error("User rejected"), { code: 4001 })), pushPsbt: vi.fn() };
    const error = await unisatHandlers(refused, USER).sendBitcoinPsbt!(PSBT).catch((e) => e);
    expect(error).not.toBeInstanceOf(SentUnclearError);
    expect(refused.pushPsbt).not.toHaveBeenCalled();

    const lost: UnisatLike = { signPsbt: async () => "signedhex", pushPsbt: async () => Promise.reject(new Error("network")) };
    await expect(unisatHandlers(lost, USER).sendBitcoinPsbt!(PSBT)).rejects.toBeInstanceOf(SentUnclearError);
  });
});
