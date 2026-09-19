import { describe, expect, it, vi } from "vitest";
import { handleWalletAction, RavnWallet } from "./wallet-dispatch";
import { makeEnvelope } from "./protocol";

function fakeWallet(overrides: Partial<RavnWallet> = {}): RavnWallet {
  return {
    address: "0xabc",
    chainId: 1,
    sendTransaction: vi.fn(async () => ({ txHash: "0xhash" })),
    signTypedData: vi.fn(async () => ({ signature: "0xsig" as const })),
    signMessage: vi.fn(async () => ({ signature: "0xsig" as const })),
    switchChain: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

describe("handleWalletAction", () => {
  it("routes wallet:sendTransaction to wallet.sendTransaction and echoes the request id", async () => {
    const wallet = fakeWallet();
    const req = makeEnvelope("wallet:sendTransaction", { chainId: 1, to: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead", value: "0" }, "req-1");

    const reply = await handleWalletAction(req, wallet);

    expect(wallet.sendTransaction).toHaveBeenCalledWith({ chainId: 1, to: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead", value: "0" });
    expect(reply).toMatchObject({ id: "req-1", type: "wallet:sendTransaction:result", payload: { txHash: "0xhash" } });
  });

  it("routes each of the four action types to its matching wallet method", async () => {
    const wallet = fakeWallet();

    await handleWalletAction(makeEnvelope("wallet:signTypedData", { chainId: 1, typedData: {} }, "a"), wallet);
    await handleWalletAction(makeEnvelope("wallet:signMessage", { chainId: 1, message: "hi" }, "b"), wallet);
    await handleWalletAction(makeEnvelope("wallet:switchChain", { chainId: 8453 }, "c"), wallet);

    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    expect(wallet.switchChain).toHaveBeenCalledWith({ chainId: 8453 });
  });

  it("returns bridge:error WALLET_NOT_CONNECTED when the host has no wallet", async () => {
    const req = makeEnvelope("wallet:sendTransaction", { chainId: 1, to: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" }, "req-2");

    const reply = await handleWalletAction(req, null);

    expect(reply.type).toBe("bridge:error");
    expect(reply.payload).toMatchObject({ error: { code: "WALLET_NOT_CONNECTED" } });
    expect(reply.id).toBe("req-2");
  });

  it("returns bridge:error UNKNOWN_MESSAGE_TYPE for a non wallet:* type", async () => {
    const req = makeEnvelope("something:else", {}, "req-3");

    const reply = await handleWalletAction(req, fakeWallet());

    expect(reply.payload).toMatchObject({ error: { code: "UNKNOWN_MESSAGE_TYPE" } });
  });

  it("catches a rejected wallet call and returns WALLET_ACTION_FAILED instead of throwing", async () => {
    const wallet = fakeWallet({ sendTransaction: vi.fn(async () => { throw new Error("user rejected"); }) });
    const req = makeEnvelope("wallet:sendTransaction", { chainId: 1, to: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" }, "req-4");

    const reply = await handleWalletAction(req, wallet);

    expect(reply.payload).toMatchObject({ error: { code: "WALLET_ACTION_FAILED", message: "user rejected" } });
  });

  it("rejects a malformed 'to' address as WALLET_ACTION_FAILED instead of relaying it to the wallet", async () => {
    const wallet = fakeWallet();
    const req = makeEnvelope("wallet:sendTransaction", { chainId: 1, to: "0xff" }, "req-5");

    const reply = await handleWalletAction(req, wallet);

    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(reply.payload).toMatchObject({ error: { code: "WALLET_ACTION_FAILED" } });
  });

  it("rejects a non-numeric chainId", async () => {
    const wallet = fakeWallet();
    const req = makeEnvelope("wallet:switchChain", { chainId: "8453" }, "req-6");

    const reply = await handleWalletAction(req, wallet);

    expect(wallet.switchChain).not.toHaveBeenCalled();
    expect(reply.payload).toMatchObject({ error: { code: "WALLET_ACTION_FAILED" } });
  });
});
