import { describe, expect, it, vi } from "vitest";
import { RavnClient } from "./client";
import { depositFeePayment, executeAndTrack } from "./execute-and-track";
import type { ExecutionDTO } from "./types";

function scriptedFetch(byPath: Record<string, unknown[]>): typeof fetch {
  const calls: Record<string, number> = {};
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname.split("/").pop()!;
    const key = path.includes("status") ? "status" : path;
    const responses = byPath[key];
    const i = calls[key] ?? 0;
    calls[key] = i + 1;
    return { ok: true, status: 200, json: async () => ({ data: responses[Math.min(i, responses.length - 1)] }) };
  }) as unknown as typeof fetch;
}

const baseParams = { quoteToken: "qt-1" };

describe("executeAndTrack: TRANSACTION", () => {
  it("waits for the approval receipt before sending the main tx, then polls to terminal", async () => {
    const fetchImpl = scriptedFetch({
      execute: [
        {
          executionType: "TRANSACTION", quoteToken: "qt-exec",
          approval: { to: "0xSpender", data: "0xapprove", value: "0", chainId: 1 },
          transaction: { to: "0xRouter", data: "0xswap", value: "0", chainId: 1 },
        },
      ],
      status: [{ status: "pending", venue: "across" }, { status: "success", venue: "across" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });
    const getStatusSpy = vi.spyOn(client, "getStatus");

    const order: string[] = [];
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => {
        order.push(`send:${tx.data}`);
        return tx.data === "0xapprove" ? "0xApprovalHash" : "0xMainHash";
      }),
      waitForReceipt: vi.fn(async (hash: string) => {
        order.push(`wait:${hash}`);
      }),
    };

    const result = await executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0 });

    expect(order).toEqual(["send:0xapprove", "wait:0xApprovalHash", "send:0xswap"]);
    expect(result.approvalTxHash).toBe("0xApprovalHash");
    expect(result.txHash).toBe("0xMainHash");
    expect(result.finalStatus).toEqual({ status: "success", venue: "across" });
    // Execute's own token, not the quote's: compose rebinds it at execute.
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", "0xMainHash", undefined);
    expect(result.quoteToken).toBe("qt-exec");
  });

  it("polls the execution's statusRef instead of the tx hash when it has one (compose)", async () => {
    const fetchImpl = scriptedFetch({
      execute: [
        { executionType: "TRANSACTION", quoteToken: "qt-bound", statusRef: "compose-ref", transaction: { to: "0xRouter" } },
      ],
      status: [{ status: "success", venue: "compose" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });
    const getStatusSpy = vi.spyOn(client, "getStatus");
    const hop1 = `0x${"c".repeat(64)}`;
    const handlers = { sendTransaction: vi.fn(async () => hop1), waitForReceipt: vi.fn(async () => {}) };

    const result = await executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0 });

    // Hop 1's tx goes along from the first poll: a two-hop route's fee is proven from it.
    expect(getStatusSpy).toHaveBeenCalledWith("qt-bound", "compose-ref", hop1);
    expect(result.statusRef).toBe("compose-ref");
    expect(result.statusTxHash).toBe(hop1);
    expect(result.txHash).toBe(hop1);
  });

  it("skips the approval step entirely when the execution has none", async () => {
    const fetchImpl = scriptedFetch({
      execute: [{ executionType: "TRANSACTION", quoteToken: "qt-exec", transaction: { to: "0xRouter", data: "0xswap" } }],
      status: [{ status: "success", venue: "relay" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });
    const handlers = {
      sendTransaction: vi.fn(async () => "0xMainHash"),
      waitForReceipt: vi.fn(async () => {}),
    };

    const result = await executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0 });

    expect(handlers.waitForReceipt).not.toHaveBeenCalled();
    expect(handlers.sendTransaction).toHaveBeenCalledOnce();
    expect(result.approvalTxHash).toBeUndefined();
  });

  it("skips sending the approval when hasAllowance reports it's already sufficient", async () => {
    const fetchImpl = scriptedFetch({
      execute: [
        {
          executionType: "TRANSACTION", quoteToken: "qt-exec",
          approval: { to: "0xSpender", data: "0xapprove", value: "0", chainId: 1 },
          transaction: { to: "0xRouter", data: "0xswap" },
        },
      ],
      status: [{ status: "success", venue: "across" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });
    const handlers = {
      sendTransaction: vi.fn(async () => "0xMainHash"),
      waitForReceipt: vi.fn(async () => {}),
      hasAllowance: vi.fn(async () => true),
    };

    const result = await executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0 });

    expect(handlers.hasAllowance).toHaveBeenCalledOnce();
    expect(handlers.waitForReceipt).not.toHaveBeenCalled();
    expect(handlers.sendTransaction).toHaveBeenCalledOnce(); // only the main tx, not the approval
    expect(result.approvalTxHash).toBeUndefined();
  });

  it("does not poll when pollUntilTerminal is false", async () => {
    const fetchImpl = scriptedFetch({
      execute: [{ executionType: "TRANSACTION", quoteToken: "qt-exec", transaction: { to: "0xRouter", data: "0xswap" } }],
      status: [{ status: "pending", venue: "relay" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });
    const getStatusSpy = vi.spyOn(client, "getStatus");
    const handlers = { sendTransaction: vi.fn(async () => "0xMainHash"), waitForReceipt: vi.fn(async () => {}) };

    const result = await executeAndTrack(client, baseParams, handlers, { pollUntilTerminal: false });

    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(result.finalStatus).toBeUndefined();
    expect(result.statusRef).toBe("0xMainHash");
  });
});

describe("executeAndTrack: SIGNATURE", () => {
  it("signs the approval and trade typed data, submits, then polls", async () => {
    const fetchImpl = scriptedFetch({
      execute: [
        {
          executionType: "SIGNATURE", quoteToken: "qt-exec",
          approvalData: { domain: {}, types: {}, primaryType: "Permit", message: {} },
          typedData: { domain: {}, types: {}, primaryType: "Order", message: {} },
          submit: { url: "/submit-signature" },
        },
      ],
      "submit-signature": [{ statusRef: "ref-1" }],
      status: [{ status: "success", venue: "0x" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });
    const submitSpy = vi.spyOn(client, "submitSignature");
    const getStatusSpy = vi.spyOn(client, "getStatus");
    const signTypedData = vi.fn(async (d: { primaryType: string }) =>
      d.primaryType === "Permit" ? "0xApprovalSig" : "0xTradeSig"
    );

    const result = await executeAndTrack(
      client,
      baseParams,
      { sendTransaction: vi.fn(), waitForReceipt: vi.fn(), signTypedData },
      { pollIntervalMs: 0 }
    );

    expect(signTypedData).toHaveBeenCalledTimes(2);
    expect(result.statusRef).toBe("ref-1");
    expect(result.finalStatus).toEqual({ status: "success", venue: "0x" });
    // Compose SIGNATURE quotes are refused at submit-signature unless given execute's token.
    expect(submitSpy).toHaveBeenCalledWith(expect.objectContaining({ quoteToken: "qt-exec" }));
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", "ref-1", undefined);
  });

  it("sends and confirms the on-chain approval before signing anything: CoW/Bebop's vault relayer and Permit2 still pull via transferFrom even on a signed order", async () => {
    const fetchImpl = scriptedFetch({
      execute: [
        {
          executionType: "SIGNATURE", quoteToken: "qt-exec",
          approval: { to: "0xVaultRelayer", data: "0xapprove", value: "0", chainId: 1 },
          typedData: { domain: {}, types: {}, primaryType: "Order", message: {} },
          submit: { url: "/submit-signature" },
        },
      ],
      "submit-signature": [{ statusRef: "ref-2" }],
      status: [{ status: "success", venue: "cow" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });
    const order: string[] = [];
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => {
        order.push(`send:${tx.data}`);
        return "0xApprovalHash";
      }),
      waitForReceipt: vi.fn(async (hash: string) => {
        order.push(`wait:${hash}`);
      }),
      signTypedData: vi.fn(async () => {
        order.push("sign");
        return "0xTradeSig" as const;
      }),
    };

    const result = await executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0 });

    expect(order).toEqual(["send:0xapprove", "wait:0xApprovalHash", "sign"]);
    expect(result.approvalTxHash).toBe("0xApprovalHash");
  });

  it("throws when the execution needs a signature but no signer was given", async () => {
    const fetchImpl = scriptedFetch({
      execute: [{ executionType: "SIGNATURE", quoteToken: "qt-exec", typedData: {}, submit: { url: "/submit-signature" } }],
    });
    const client = new RavnClient({ fetch: fetchImpl });

    await expect(
      executeAndTrack(client, baseParams, { sendTransaction: vi.fn(), waitForReceipt: vi.fn() })
    ).rejects.toThrow(/signTypedData/);
  });

  it("checks for missing typedData before ever prompting a signature for approvalData", async () => {
    const fetchImpl = scriptedFetch({
      execute: [
        { executionType: "SIGNATURE", quoteToken: "qt-exec", approvalData: { primaryType: "Permit" }, submit: { url: "/submit-signature" } },
      ],
    });
    const client = new RavnClient({ fetch: fetchImpl });
    const signTypedData = vi.fn(async () => "0xSig" as const);

    await expect(
      executeAndTrack(client, baseParams, { sendTransaction: vi.fn(), waitForReceipt: vi.fn(), signTypedData })
    ).rejects.toThrow(/typedData/);
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

describe("executeAndTrack: DEPOSIT", () => {
  it("returns immediately without polling: the deposit itself happens out-of-band", async () => {
    const fetchImpl = scriptedFetch({
      execute: [{ executionType: "DEPOSIT", quoteToken: "qt-exec", deposit: { address: "bc1q...", amount: "100000" }, statusRef: "dep-1" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });
    const getStatusSpy = vi.spyOn(client, "getStatus");

    const result = await executeAndTrack(client, baseParams, { sendTransaction: vi.fn(), waitForReceipt: vi.fn() });

    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(result.statusRef).toBe("dep-1");
    expect(result.quoteToken).toBe("qt-exec");
    expect(result.finalStatus).toBeUndefined();
  });
});

// broadcastViaRavn: a Layerswap memo payment must reach the chain through RAVN's check, never
// through the caller's own sendTransaction.
describe("executeAndTrack: TRANSACTION with submit", () => {
  const execution = {
    executionType: "TRANSACTION", quoteToken: "qt-exec", statusRef: "ls-swap-id",
    transaction: { chainId: -2, serialized: "AQID" },
    submit: { url: "/api/v1/submit-transaction" },
  };

  it("signs only, submits through RAVN, and polls the execution's statusRef", async () => {
    const fetchImpl = scriptedFetch({
      execute: [execution],
      "submit-transaction": [{ txHash: "5igSig" }],
      status: [{ status: "success", venue: "layerswap" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });
    const submitSpy = vi.spyOn(client, "submitTransaction");
    const handlers = {
      sendTransaction: vi.fn(async () => "never"),
      waitForReceipt: vi.fn(async () => {}),
      signSolanaTransaction: vi.fn(async (tx: string) => `signed:${tx}`),
    };

    const result = await executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0 });

    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(handlers.signSolanaTransaction).toHaveBeenCalledWith("AQID");
    expect(submitSpy).toHaveBeenCalledWith({ quoteToken: "qt-exec", signedTransaction: "signed:AQID" });
    expect(result.txHash).toBe("5igSig");
    expect(result.statusRef).toBe("ls-swap-id");
    expect(result.finalStatus).toEqual({ status: "success", venue: "layerswap" });
  });

  it("refuses rather than broadcasting when it can't sign without sending", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution] }) });
    const handlers = { sendTransaction: vi.fn(async () => "never"), waitForReceipt: vi.fn(async () => {}) };

    await expect(executeAndTrack(client, baseParams, handlers)).rejects.toThrow(/signSolanaTransaction/);
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
  });
});

// RAVN's fee beside a route that has none of its own (Eco, Layerswap, Mayan plain MCTP): sent, and
// its hash reported, or no fee is owed to the integrator.
describe("executeAndTrack: TRANSACTION with fee", () => {
  const [SWAP, FEE, BATCH] = ["a", "f", "b"].map((c) => `0x${c.repeat(64)}`);
  const tokenFee = { amount: "500", address: "0xRavnFee", chainId: 8453, transaction: { to: "0xUSDC", data: "0xfeetransfer", value: "0", chainId: 8453 } };
  const coinFee = { amount: "500", address: "0xRavnFee", chainId: 8453, transaction: { to: "0xRavnFee", data: "0xtag", value: "500", chainId: 8453 } };
  const withFee = (fee: unknown, extra: Record<string, unknown> = {}) => ({
    executionType: "TRANSACTION", quoteToken: "qt-exec", transaction: { to: "0xEco", data: "0xswap", value: "0", chainId: 8453 }, fee, ...extra,
  });
  const run = async (execution: unknown, handlers: Parameters<typeof executeAndTrack>[2]) => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], status: [{ status: "pending", venue: "eco" }, { status: "success", venue: "eco" }] }) });
    const getStatusSpy = vi.spyOn(client, "getStatus");
    const result = await executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0 });
    return { result, getStatusSpy };
  };

  it("sends the fee exactly as given once the swap has confirmed, waits for it, and reports its hash on every poll", async () => {
    const order: string[] = [];
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => {
        order.push(`send:${tx.data}`);
        return tx.data === "0xswap" ? SWAP : FEE;
      }),
      waitForReceipt: vi.fn(async (hash: string, chainId?: number) => {
        order.push(`wait:${hash.slice(0, 3)}:${chainId}`);
        return { status: "success" };
      }),
    };

    const { result, getStatusSpy } = await run(withFee(tokenFee), handlers);

    expect(order).toEqual(["send:0xswap", "wait:0xa:8453", "send:0xfeetransfer", "wait:0xf:8453"]);
    expect(handlers.sendTransaction).toHaveBeenLastCalledWith(tokenFee.transaction);
    expect(result).toMatchObject({ txHash: SWAP, statusRef: SWAP, feeTxHash: FEE, statusTxHash: FEE });
    expect(result.feeError).toBeUndefined();
    expect(getStatusSpy).toHaveBeenCalledTimes(2);
    for (const call of getStatusSpy.mock.calls) expect(call).toEqual(["qt-exec", SWAP, FEE]);
  });

  it("batches a token fee into the swap's own confirmation when the caller can send calls", async () => {
    const handlers = {
      sendTransaction: vi.fn(async () => "never"),
      waitForReceipt: vi.fn(async () => {}),
      sendCalls: vi.fn(async () => [BATCH]), // one atomic transaction carried both
    };

    const { result, getStatusSpy } = await run(withFee(tokenFee, { statusRef: "eco-ref" }), handlers);

    expect(handlers.sendCalls).toHaveBeenCalledWith([withFee(tokenFee).transaction, tokenFee.transaction]);
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ txHash: BATCH, feeTxHash: BATCH, statusRef: "eco-ref" });
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", "eco-ref", BATCH);
  });

  it("never batches a native-coin fee: a plain transaction of its own, after the swap", async () => {
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => (tx.data === "0xswap" ? SWAP : FEE)),
      waitForReceipt: vi.fn(async () => {}),
      sendCalls: vi.fn(async () => ["never"]),
    };

    const { result } = await run(withFee(coinFee), handlers);

    expect(handlers.sendCalls).not.toHaveBeenCalled();
    expect(handlers.sendTransaction).toHaveBeenCalledTimes(2);
    expect(handlers.sendTransaction).toHaveBeenLastCalledWith(coinFee.transaction);
    expect(result.feeTxHash).toBe(FEE);
  });

  it("doesn't send the fee on a swap whose receipt says it reverted, and still tracks the swap", async () => {
    const handlers = {
      sendTransaction: vi.fn(async () => SWAP),
      waitForReceipt: vi.fn(async () => ({ status: "reverted" })),
    };

    const { result, getStatusSpy } = await run(withFee(tokenFee), handlers);

    expect(handlers.sendTransaction).toHaveBeenCalledOnce();
    expect(result.feeTxHash).toBeUndefined();
    expect(String(result.feeError)).toMatch(/did not succeed/);
    expect(result.finalStatus?.status).toBe("success");
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", SWAP, undefined);
  });

  it("returns the swap, not an error, when the user declines the fee", async () => {
    const declined = new Error("User rejected the request");
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => {
        if (tx.data === "0xfeetransfer") throw declined;
        return SWAP;
      }),
      waitForReceipt: vi.fn(async () => {}),
    };

    const { result } = await run(withFee(tokenFee), handlers);

    expect(result.txHash).toBe(SWAP);
    expect(result.feeError).toBe(declined);
    expect(result.finalStatus?.status).toBe("success");
  });

  it("never reports a batch id as txHash: /v1/status would refuse every poll", async () => {
    const handlers = { sendTransaction: vi.fn(async () => "never"), waitForReceipt: vi.fn(async () => {}), sendCalls: vi.fn(async () => [SWAP, "0xbatch-id"]) };

    const { result, getStatusSpy } = await run(withFee(tokenFee), handlers);

    expect(result.statusTxHash).toBeUndefined();
    expect(String(result.feeError)).toMatch(/not an on-chain transaction hash/);
    expect(result.finalStatus?.status).toBe("success");
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", SWAP, undefined);
  });

  it("sends nothing extra when the fee is inside a Solana transaction, and passes no Solana signature as txHash", async () => {
    const solanaFee = { amount: "500", address: "RavnFeeSol", chainId: -2 };
    const execution = { executionType: "TRANSACTION", quoteToken: "qt-exec", statusRef: "compose-ref", transaction: { chainId: -2, serialized: "AQID" }, fee: solanaFee };
    const handlers = { sendTransaction: vi.fn(async () => "5igSig"), waitForReceipt: vi.fn(async () => {}) };

    const { result, getStatusSpy } = await run(execution, handlers);

    expect(handlers.sendTransaction).toHaveBeenCalledOnce();
    expect(handlers.waitForReceipt).not.toHaveBeenCalled();
    expect(result.statusTxHash).toBeUndefined();
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", "compose-ref", undefined);
  });
});

describe("depositFeePayment", () => {
  const deposit = (fee?: unknown) => ({ executionType: "DEPOSIT", quoteToken: "qt", deposit: { address: "dep", amount: "1000" }, statusRef: "ref", fee }) as ExecutionDTO;

  it("EVM: the fee transaction, exactly as given", () => {
    const transaction = { to: "0xUSDC", data: "0xtransfer", value: "0", chainId: 1 };
    expect(depositFeePayment(deposit({ amount: "5", address: "0xRavn", chainId: 1, transaction }))).toEqual({ kind: "transaction", transaction });
  });

  it("Bitcoin and Solana: paid inside the deposit's own transaction, to RAVN's address", () => {
    expect(depositFeePayment(deposit({ amount: "5", address: "bc1qravn", chainId: -1 }))).toEqual({ kind: "bitcoin_output", address: "bc1qravn", amount: "5" });
    expect(depositFeePayment(deposit({ amount: "5", address: "RavnSol", chainId: -2 }))).toEqual({ kind: "solana_transfer", address: "RavnSol", amount: "5" });
  });

  it("nothing to pay without a fee; refuses a fee it can't describe rather than guess", () => {
    expect(depositFeePayment(deposit())).toBeUndefined();
    expect(() => depositFeePayment(deposit({ amount: "5", address: "x", chainId: 999 }))).toThrow(/chain 999/);
  });

  it("executeAndTrack hands it back on a DEPOSIT", async () => {
    const execution = deposit({ amount: "5", address: "bc1qravn", chainId: -1 });
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution] }) });

    const result = await executeAndTrack(client, baseParams, { sendTransaction: vi.fn(), waitForReceipt: vi.fn() });

    expect(result.feePayment).toEqual({ kind: "bitcoin_output", address: "bc1qravn", amount: "5" });
  });
});
