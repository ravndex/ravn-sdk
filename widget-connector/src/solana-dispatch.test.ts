import { describe, expect, it, vi } from "vitest";
import { handleSolanaAction, RavnSolanaWallet } from "./wallet-dispatch";
import { makeEnvelope } from "./protocol";

function fakeSolanaWallet(overrides: Partial<RavnSolanaWallet> = {}): RavnSolanaWallet {
  return {
    address: "SoLanaAddr111",
    signTransaction: vi.fn(async () => ({ signedTransaction: "c2lnbmVk" })),
    ...overrides,
  };
}

describe("handleSolanaAction", () => {
  it("routes solana:signTransaction to wallet.signTransaction and echoes the request id", async () => {
    const wallet = fakeSolanaWallet();
    const req = makeEnvelope("solana:signTransaction", { transaction: "dW5zaWduZWQ=" }, "req-1");

    const reply = await handleSolanaAction(req, wallet);

    expect(wallet.signTransaction).toHaveBeenCalledWith({ transaction: "dW5zaWduZWQ=" });
    expect(reply).toMatchObject({
      id: "req-1",
      type: "solana:signTransaction:result",
      payload: { signedTransaction: "c2lnbmVk" },
    });
  });

  it("returns bridge:error SOLANA_WALLET_NOT_CONNECTED when the host has no Solana wallet", async () => {
    const req = makeEnvelope("solana:signTransaction", { transaction: "x" }, "req-2");

    const reply = await handleSolanaAction(req, null);

    expect(reply.type).toBe("bridge:error");
    expect(reply.payload).toMatchObject({ error: { code: "SOLANA_WALLET_NOT_CONNECTED" } });
    expect(reply.id).toBe("req-2");
  });

  it("returns bridge:error UNKNOWN_MESSAGE_TYPE for a non solana:* type", async () => {
    const req = makeEnvelope("wallet:sendTransaction", {}, "req-3");

    const reply = await handleSolanaAction(req, fakeSolanaWallet());

    expect(reply.payload).toMatchObject({ error: { code: "UNKNOWN_MESSAGE_TYPE" } });
  });

  it("catches a rejected signTransaction and returns WALLET_ACTION_FAILED instead of throwing", async () => {
    const wallet = fakeSolanaWallet({
      signTransaction: vi.fn(async () => {
        throw new Error("user rejected");
      }),
    });
    const req = makeEnvelope("solana:signTransaction", { transaction: "x" }, "req-4");

    const reply = await handleSolanaAction(req, wallet);

    expect(reply.payload).toMatchObject({ error: { code: "WALLET_ACTION_FAILED", message: "user rejected" } });
  });
});
