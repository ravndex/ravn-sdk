import { describe, expect, it, vi } from "vitest";
import { RavnClient } from "./client";
import { depositFeePayment, executeAndTrack, ExecuteAndTrackError } from "./execute-and-track";
import type { ExecuteAndTrackHandlers, ExecuteAndTrackProgress } from "./execute-and-track";
import { RavnApiError } from "./types";
import type { ExecutionDTO } from "./types";

const FAIL = Symbol("http error");
const HANG = Symbol("never answers");
/** A scripted response the API answers with `status` and this error envelope. */
const httpError = (status: number, code: string, details?: unknown) => ({ [FAIL]: { status, code, details } });

// Each path answers its scripted responses in order, then repeats the last. An Error entry is a
// network failure (fetch rejects), httpError() an error envelope, HANG a request that only ends
// when its signal aborts.
function scriptedFetch(byPath: Record<string, unknown[]>): typeof fetch {
  const calls: Record<string, number> = {};
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.split("/").pop()!;
    const key = path.includes("status") ? "status" : path;
    const responses = byPath[key];
    const i = calls[key] ?? 0;
    calls[key] = i + 1;
    const r = responses[Math.min(i, responses.length - 1)];
    if (r instanceof Error) throw r;
    if (r === HANG) {
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    if (r && typeof r === "object" && FAIL in r) {
      const { status, code, details } = (r as ReturnType<typeof httpError>)[FAIL];
      return { ok: false, status, json: async () => ({ error: { code, message: code, details } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: r }) };
  }) as unknown as typeof fetch;
}

/** What viem's waitForTransactionReceipt resolves to, as far as executeAndTrack reads it. */
const receipt = (hash: string) => ({ status: "success" as const, transactionHash: hash });

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
        return receipt(hash);
      }),
    };

    const result = await executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0 });

    expect(order).toEqual(["send:0xapprove", "wait:0xApprovalHash", "send:0xswap"]);
    expect(result.approvalTxHash).toBe("0xApprovalHash");
    expect(result.txHash).toBe("0xMainHash");
    expect(result.finalStatus).toEqual({ status: "success", venue: "across" });
    // Execute's own token, not the quote's: compose rebinds it at execute.
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", "0xMainHash", undefined, expect.anything());
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
    const handlers = { sendTransaction: vi.fn(async () => hop1), waitForReceipt: vi.fn(async (hash: string) => receipt(hash)) };

    const result = await executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0 });

    // Hop 1's tx goes along from the first poll: a two-hop route's fee is proven from it.
    expect(getStatusSpy).toHaveBeenCalledWith("qt-bound", "compose-ref", hop1, expect.anything());
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
      waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
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
      waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
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
    const handlers = { sendTransaction: vi.fn(async () => "0xMainHash"), waitForReceipt: vi.fn(async (hash: string) => receipt(hash)) };

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
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", "ref-1", undefined, expect.anything());
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
        return receipt(hash);
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

// sendDeposit: the SDK sends a DEPOSIT itself from the ready-to-sign payload RAVN returns (ravn-mvp
// #426), RAVN's fee inside it, so an integrator never builds the fee payment by hand.
describe("executeAndTrack: DEPOSIT with sendDeposit", () => {
  const [DEP, FEE] = ["d", "f"].map((c) => `0x${c.repeat(64)}`);
  const DEPOSIT_ADDRESS = `0x${"de".repeat(20)}`;
  // transfer(deposit.address, deposit.amount), as RAVN builds it.
  const transferData = `0xa9059cbb${DEPOSIT_ADDRESS.slice(2).padStart(64, "0")}${(995000).toString(16).padStart(64, "0")}`;
  const depositCall = { to: "0xUSDC", data: transferData, value: "0", chainId: 8453 };
  const feeTx = { to: "0xUSDC", data: "0xfeetransfer", value: "0", chainId: 8453 };
  const evm = {
    executionType: "DEPOSIT", quoteToken: "qt-exec", statusRef: "rift-order-1",
    deposit: { address: DEPOSIT_ADDRESS, amount: "995000", chainId: 8453 },
    fee: { amount: "5000", address: "0xRavnFee", chainId: 8453, transaction: feeTx },
    calls: [depositCall, feeTx],
    batch: true,
  };
  const success = { status: "success", venue: "rift" };
  const evmHandlers = (over: Partial<ExecuteAndTrackHandlers> = {}) => {
    const order: string[] = [];
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => {
        order.push(`send:${tx.data}`);
        return tx.data === "0xfeetransfer" ? FEE : DEP;
      }),
      waitForReceipt: vi.fn(async (hash: string) => {
        order.push(`wait:${hash}`);
        return receipt(hash);
      }),
      ...over,
    };
    return { order, handlers };
  };
  const run = (execution: unknown, handlers: ExecuteAndTrackHandlers, options = {}) => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], status: [success] }) });
    const getStatus = vi.spyOn(client, "getStatus");
    return { getStatus, result: executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0, sendDeposit: true, ...options }) };
  };

  it("without sendDeposit nothing is sent, even with the deposit ready to sign (no change for today's integrators)", async () => {
    const { handlers } = evmHandlers({ sendCalls: vi.fn() });
    const { result, getStatus } = run(evm, handlers, { sendDeposit: undefined });
    const r = await result;
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(handlers.sendCalls).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
    expect(r.feePayment).toEqual({ kind: "transaction", transaction: feeTx });
    expect(r.txHash).toBeUndefined();
  });

  it("EVM, batchable: deposit and RAVN's fee in one wallet confirmation, then tracked with the tx that carried the fee", async () => {
    const sendCalls = vi.fn(async () => [DEP]);
    const { handlers } = evmHandlers({ sendCalls });
    const { result, getStatus } = run(evm, handlers);
    const r = await result;
    expect(sendCalls).toHaveBeenCalledWith([depositCall, feeTx]);
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(r).toMatchObject({ txHash: DEP, feeTxHash: DEP, statusRef: "rift-order-1", statusTxHash: DEP, finalStatus: success });
    expect(r.feePayment).toBeUndefined();
    expect(r.depositNotSent).toBeUndefined();
    expect(getStatus).toHaveBeenCalledWith("qt-exec", "rift-order-1", DEP, expect.anything());
    // A success answered before RAVN's node sees the fee proves nothing: one more poll.
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("EVM, not batchable (a native-coin deposit): the deposit, its receipt, then the fee, then tracked with the fee tx", async () => {
    const coinDeposit = { to: DEPOSIT_ADDRESS, data: "0x", value: "995000", chainId: 8453 };
    const coinFee = { to: "0xRavnFee", data: "0xtag", value: "5000", chainId: 8453 };
    const execution = { ...evm, fee: { ...evm.fee, transaction: coinFee }, calls: [coinDeposit, coinFee], batch: false };
    const { order, handlers } = evmHandlers({
      sendCalls: vi.fn(),
      sendTransaction: vi.fn(async (tx: { data?: string }) => {
        order.push(`send:${tx.data}`);
        return tx.data === "0xtag" ? FEE : DEP;
      }),
    });
    const { result, getStatus } = run(execution, handlers);
    const r = await result;
    expect(order).toEqual(["send:0x", `wait:${DEP}`, "send:0xtag", `wait:${FEE}`]);
    expect(handlers.sendCalls).not.toHaveBeenCalled();
    expect(r).toMatchObject({ txHash: DEP, feeTxHash: FEE, statusTxHash: FEE, finalStatus: success });
    expect(getStatus).toHaveBeenCalledWith("qt-exec", "rift-order-1", FEE, expect.anything());
  });

  it("EVM: a deposit that didn't succeed gets no fee; it is still tracked", async () => {
    const { handlers } = evmHandlers({ waitForReceipt: vi.fn(async (hash: string) => ({ status: "reverted", transactionHash: hash })) });
    const { result, getStatus } = run({ ...evm, batch: false }, handlers);
    const r = await result;
    expect(handlers.sendTransaction).toHaveBeenCalledTimes(1);
    expect(r.feeTxHash).toBeUndefined();
    expect(String(r.feeError)).toMatch(/receipt/);
    expect(r.txHash).toBe(DEP);
    expect(getStatus).toHaveBeenCalledWith("qt-exec", "rift-order-1", undefined, expect.anything());
  });

  it("EVM: a declined fee never fails the deposit, which is still tracked", async () => {
    const { handlers } = evmHandlers({
      sendTransaction: vi.fn(async (tx: { data?: string }) => {
        if (tx.data === "0xfeetransfer") throw new Error("User rejected the request");
        return DEP;
      }),
    });
    const r = await run({ ...evm, batch: false }, handlers).result;
    expect(String(r.feeError)).toMatch(/rejected/);
    expect(r).toMatchObject({ txHash: DEP, finalStatus: success });
  });

  it("EVM: a deposit call that doesn't pay deposit.amount to deposit.address is not sent", async () => {
    const { handlers } = evmHandlers({ sendCalls: vi.fn() });
    const wrongAmount = { ...depositCall, data: transferData.replace(/f2eb8$/, "f2eb9") };
    const wrongCoin = { to: `0x${"ab".repeat(20)}`, data: "0x", value: "995000", chainId: 8453 };
    for (const call of [wrongAmount, wrongCoin]) {
      const r = await run({ ...evm, calls: [call, feeTx] }, handlers).result;
      expect(r.depositNotSent).toMatch(/deposit/);
    }
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(handlers.sendCalls).not.toHaveBeenCalled();
  });

  it("an execution type this version doesn't know is never sent", async () => {
    const { handlers } = evmHandlers({ sendCalls: vi.fn() });
    const r = await run({ ...evm, executionType: "INTENT" }, handlers).result;
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(handlers.sendCalls).not.toHaveBeenCalled();
    expect(r.txHash).toBeUndefined();
    expect(r.depositNotSent).toMatch(/INTENT/);
  });

  it("EVM: calls that don't end in the fee as given are not sent: handed back to pay as today", async () => {
    const { handlers } = evmHandlers({ sendCalls: vi.fn() });
    const r = await run({ ...evm, calls: [feeTx, depositCall] }, handlers).result;
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(handlers.sendCalls).not.toHaveBeenCalled();
    expect(r.depositNotSent).toMatch(/fee/);
    expect(r.feePayment).toEqual({ kind: "transaction", transaction: feeTx });
    expect(r.finalStatus).toBeUndefined();
  });

  const btcFee = { amount: "600", address: "bc1qravn", chainId: -1 };
  const btc = { executionType: "DEPOSIT", quoteToken: "qt-exec", statusRef: "near-dep-1", deposit: { address: "bc1qdeposit", amount: "99400", chainId: -1, psbt: "cHNidP8B" }, fee: btcFee };

  it("Bitcoin: the PSBT RAVN built (its fee a second output) goes to sendBitcoinPsbt, then the swap is tracked", async () => {
    const sendBitcoinPsbt = vi.fn(async () => "a".repeat(64));
    const { handlers } = evmHandlers({ sendBitcoinPsbt });
    const { result, getStatus } = run(btc, handlers);
    const r = await result;
    expect(sendBitcoinPsbt).toHaveBeenCalledWith("cHNidP8B");
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(r).toMatchObject({ txHash: "a".repeat(64), statusRef: "near-dep-1", finalStatus: success });
    expect(r.feePayment).toBeUndefined();
    // Not an EVM hash: /v1/status refuses it as txHash, and RAVN finds the fee from the deposit.
    expect(getStatus).toHaveBeenCalledWith("qt-exec", "near-dep-1", undefined, expect.anything());
  });

  it("Bitcoin without a PSBT (a sender that isn't bc1q…): nothing sent, handed back to pay as today", async () => {
    const sendBitcoinPsbt = vi.fn();
    const { handlers } = evmHandlers({ sendBitcoinPsbt });
    const r = await run({ ...btc, deposit: { ...btc.deposit, psbt: undefined } }, handlers).result;
    expect(sendBitcoinPsbt).not.toHaveBeenCalled();
    expect(r.depositNotSent).toMatch(/PSBT/);
    expect(r.feePayment).toEqual({ kind: "bitcoin_output", address: "bc1qravn", amount: "600" });
    expect(r.txHash).toBeUndefined();
  });

  const sol = {
    executionType: "DEPOSIT", quoteToken: "qt-exec", statusRef: "houdini-1",
    deposit: { address: "DepSol", amount: "4975000", chainId: -2, transaction: "AQIDsol" },
    fee: { amount: "25000", address: "RavnSol", chainId: -2 },
  };

  it("Solana: the deposit+fee transaction goes to sendSolanaTransaction, then the swap is tracked", async () => {
    const sendSolanaTransaction = vi.fn(async () => "5igSolanaSig");
    const signSolanaTransaction = vi.fn();
    const { handlers } = evmHandlers({ sendSolanaTransaction, signSolanaTransaction });
    const { result, getStatus } = run(sol, handlers);
    const r = await result;
    expect(sendSolanaTransaction).toHaveBeenCalledWith("AQIDsol");
    expect(signSolanaTransaction).not.toHaveBeenCalled();
    expect(r).toMatchObject({ txHash: "5igSolanaSig", statusRef: "houdini-1", finalStatus: success });
    expect(getStatus).toHaveBeenCalledWith("qt-exec", "houdini-1", undefined, expect.anything());
  });

  it("Solana with no sendSolanaTransaction handler: nothing sent, the reason names the handler", async () => {
    const { handlers } = evmHandlers();
    const r = await run(sol, handlers).result;
    expect(r.depositNotSent).toMatch(/sendSolanaTransaction/);
    expect(r.feePayment).toEqual({ kind: "solana_transfer", address: "RavnSol", amount: "25000" });
  });

  it("a sandbox deposit is never sent: its status is polled like any sandbox swap", async () => {
    const sendCalls = vi.fn();
    const { handlers } = evmHandlers({ sendCalls });
    const { result, getStatus } = run({ ...evm, sandbox: true }, handlers);
    const r = await result;
    expect(sendCalls).not.toHaveBeenCalled();
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(r.finalStatus).toEqual(success);
    expect(getStatus).toHaveBeenCalledWith("qt-exec", "rift-order-1", undefined, expect.anything());
  });

  it("once the deposit is out, a failure carries its hash", async () => {
    const { handlers } = evmHandlers({ sendCalls: vi.fn(async () => [DEP]) });
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [evm], status: [httpError(400, "INVALID_REQUEST")] }) });
    const err = await executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0, sendDeposit: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ExecuteAndTrackError);
    expect(err.partial).toMatchObject({ txHash: DEP, feeTxHash: DEP, statusRef: "rift-order-1", statusTxHash: DEP });
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
      waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
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
    const handlers = { sendTransaction: vi.fn(async () => "never"), waitForReceipt: vi.fn(async (hash: string) => receipt(hash)) };

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
        return { status: "success", transactionHash: hash };
      }),
    };

    const { result, getStatusSpy } = await run(withFee(tokenFee), handlers);

    expect(order).toEqual(["send:0xswap", "wait:0xa:8453", "send:0xfeetransfer", "wait:0xf:8453"]);
    expect(handlers.sendTransaction).toHaveBeenLastCalledWith(tokenFee.transaction);
    expect(result).toMatchObject({ txHash: SWAP, statusRef: SWAP, feeTxHash: FEE, statusTxHash: FEE });
    expect(result.feeError).toBeUndefined();
    // pending, success, then one more: RAVN's node may be a block behind on the fee tx.
    expect(getStatusSpy).toHaveBeenCalledTimes(3);
    for (const call of getStatusSpy.mock.calls) expect(call.slice(0, 3)).toEqual(["qt-exec", SWAP, FEE]);
  });

  it("batches a token fee into the swap's own confirmation when the caller can send calls", async () => {
    const handlers = {
      sendTransaction: vi.fn(async () => "never"),
      waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
      sendCalls: vi.fn(async () => [BATCH]), // one atomic transaction carried both
    };

    const { result, getStatusSpy } = await run(withFee(tokenFee, { statusRef: "eco-ref" }), handlers);

    expect(handlers.sendCalls).toHaveBeenCalledWith([withFee(tokenFee).transaction, tokenFee.transaction]);
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ txHash: BATCH, feeTxHash: BATCH, statusRef: "eco-ref" });
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", "eco-ref", BATCH, expect.anything());
  });

  it("batches a coin sell with its fee when RAVN says so (the fee minted to RAVN as WETH)", async () => {
    // Robinhood: the coin sent to WETH's depositTo for RAVN, tagged; its Transfer log proves it in the batch.
    const wethFee = { amount: "500", address: "0xRavnFee", chainId: 4663, transaction: { to: "0xWETH", data: "0xb760faf9tag", value: "500", chainId: 4663 } };
    const coinSell = { ...withFee(wethFee), transaction: { to: "0xFly", data: "0xswap", value: "99500", chainId: 4663 }, batch: true };
    const handlers = {
      sendTransaction: vi.fn(async () => "never"),
      waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
      sendCalls: vi.fn(async () => [BATCH]), // one 7702 transaction carried both
    };

    const { result, getStatusSpy } = await run(coinSell, handlers);

    expect(handlers.sendCalls).toHaveBeenCalledWith([coinSell.transaction, wethFee.transaction]);
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ txHash: BATCH, feeTxHash: BATCH, statusRef: BATCH, statusTxHash: BATCH });
    for (const call of getStatusSpy.mock.calls) expect(call.slice(0, 3)).toEqual(["qt-exec", BATCH, BATCH]);
  });

  it("with no sendCalls, sends a batchable coin sell's fee after the swap's receipt", async () => {
    const wethFee = { amount: "500", address: "0xRavnFee", chainId: 4663, transaction: { to: "0xWETH", data: "0xb760faf9tag", value: "500", chainId: 4663 } };
    const coinSell = { ...withFee(wethFee), transaction: { to: "0xFly", data: "0xswap", value: "99500", chainId: 4663 }, batch: true };
    const order: string[] = [];
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => (order.push(`send:${tx.data}`), tx.data === "0xswap" ? SWAP : FEE)),
      waitForReceipt: vi.fn(async (hash: string) => (order.push(`wait:${hash.slice(0, 3)}`), receipt(hash))),
    };

    const { result } = await run(coinSell, handlers);

    expect(order).toEqual(["send:0xswap", "wait:0xa", "send:0xb760faf9tag", "wait:0xf"]);
    expect(result).toMatchObject({ txHash: SWAP, feeTxHash: FEE, statusTxHash: FEE });
  });

  it("never batches a fee RAVN says can't share the swap's confirmation, even a token one", async () => {
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => (tx.data === "0xswap" ? SWAP : FEE)),
      waitForReceipt: vi.fn(async (hash: string) => ({ status: "success", transactionHash: hash })),
      sendCalls: vi.fn(async () => ["never"]),
    };

    const { result } = await run(withFee(tokenFee, { batch: false }), handlers);

    expect(handlers.sendCalls).not.toHaveBeenCalled();
    expect(handlers.sendTransaction).toHaveBeenLastCalledWith(tokenFee.transaction);
    expect(result).toMatchObject({ txHash: SWAP, feeTxHash: FEE });
  });

  it("never batches a native-coin fee: a plain transaction of its own, after the swap", async () => {
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => (tx.data === "0xswap" ? SWAP : FEE)),
      waitForReceipt: vi.fn(async (hash: string) => ({ status: "success", transactionHash: hash })),
      sendCalls: vi.fn(async () => ["never"]),
    };

    const { result } = await run(withFee(coinFee), handlers);

    expect(handlers.sendCalls).not.toHaveBeenCalled();
    expect(handlers.sendTransaction).toHaveBeenCalledTimes(2);
    expect(handlers.sendTransaction).toHaveBeenLastCalledWith(coinFee.transaction);
    expect(result.feeTxHash).toBe(FEE);
  });

  // Fail closed: only a receipt that says success and is the swap's own sends the fee.
  it.each([
    ["reverted (viem)", { status: "reverted" }],
    ["reverted (ethers)", { status: 0 }],
    ["no receipt (a void handler)", undefined],
    ["a boolean", false],
    ["cancelled: viem resolves with the replacement's receipt", { status: "success", transactionHash: `0x${"9".repeat(64)}` }],
  ])("sends no fee when waitForReceipt resolves %s, and still tracks the swap", async (_, receipt) => {
    // `as never`: a JS caller can still hand back anything; the runtime check is what refuses it.
    const handlers = { sendTransaction: vi.fn(async () => SWAP), waitForReceipt: vi.fn(async () => receipt as never) };

    const { result, getStatusSpy } = await run(withFee(tokenFee), handlers);

    expect(handlers.sendTransaction).toHaveBeenCalledOnce();
    expect(result.feeTxHash).toBeUndefined();
    expect(String(result.feeError)).toMatch(/no successful receipt/);
    expect(result.finalStatus?.status).toBe("success");
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", SWAP, undefined, expect.anything());
  });

  it("takes ethers v6's receipt (hash, status 1) as the swap's own", async () => {
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => (tx.data === "0xswap" ? SWAP : FEE)),
      waitForReceipt: vi.fn(async (hash: string) => ({ status: 1, hash: hash.toUpperCase().replace("0X", "0x") })),
    };

    const { result } = await run(withFee(tokenFee), handlers);

    expect(result.feeTxHash).toBe(FEE);
    expect(result.feeError).toBeUndefined();
  });

  it("returns the swap, not an error, when the user declines the fee", async () => {
    const declined = new Error("User rejected the request");
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => {
        if (tx.data === "0xfeetransfer") throw declined;
        return SWAP;
      }),
      waitForReceipt: vi.fn(async (hash: string) => ({ status: 1, hash })),
    };

    const { result } = await run(withFee(tokenFee), handlers);

    expect(result.txHash).toBe(SWAP);
    expect(result.feeError).toBe(declined);
    expect(result.finalStatus?.status).toBe("success");
  });

  it("never reports a batch id as txHash: /v1/status would refuse every poll", async () => {
    const handlers = { sendTransaction: vi.fn(async () => "never"), waitForReceipt: vi.fn(async (hash: string) => receipt(hash)), sendCalls: vi.fn(async () => [SWAP, "0xbatch-id"]) };

    const { result, getStatusSpy } = await run(withFee(tokenFee), handlers);

    expect(result.statusTxHash).toBeUndefined();
    expect(String(result.feeError)).toMatch(/not an on-chain transaction hash/);
    expect(result.finalStatus?.status).toBe("success");
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", SWAP, undefined, expect.anything());
  });

  it("sends nothing extra when the fee is inside a Solana transaction, and passes no Solana signature as txHash", async () => {
    const solanaFee = { amount: "500", address: "RavnFeeSol", chainId: -2 };
    const execution = { executionType: "TRANSACTION", quoteToken: "qt-exec", statusRef: "compose-ref", transaction: { chainId: -2, serialized: "AQID" }, fee: solanaFee };
    const handlers = { sendTransaction: vi.fn(async () => "5igSig"), waitForReceipt: vi.fn(async (hash: string) => receipt(hash)) };

    const { result, getStatusSpy } = await run(execution, handlers);

    expect(handlers.sendTransaction).toHaveBeenCalledOnce();
    expect(handlers.waitForReceipt).not.toHaveBeenCalled();
    expect(result.statusTxHash).toBeUndefined();
    expect(getStatusSpy).toHaveBeenCalledWith("qt-exec", "compose-ref", undefined, expect.anything());
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

  it("executeAndTrack reports a fee it can't describe instead of failing the deposit", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [deposit({ amount: "5", address: "x", chainId: 999 })] }) });

    const result = await executeAndTrack(client, baseParams, { sendTransaction: vi.fn(), waitForReceipt: vi.fn() });

    expect(result.statusRef).toBe("ref");
    expect(result.feePayment).toBeUndefined();
    expect(String(result.feeError)).toMatch(/chain 999/);
  });

  it("executeAndTrack hands it back on a DEPOSIT", async () => {
    const execution = deposit({ amount: "5", address: "bc1qravn", chainId: -1 });
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution] }) });

    const result = await executeAndTrack(client, baseParams, { sendTransaction: vi.fn(), waitForReceipt: vi.fn() });

    expect(result.feePayment).toEqual({ kind: "bitcoin_output", address: "bc1qravn", amount: "5" });
  });
});

// Claim 1 (audit 2026-10-17): once anything is sent, a status error must never lose the swap.
describe("executeAndTrack: once the swap is out, an error never loses it", () => {
  const [APPROVAL, SWAP, FEE] = ["e", "a", "f"].map((c) => `0x${c.repeat(64)}`);
  const approval = { to: "0xToken", data: "0xapprove", value: "0", chainId: 8453 };
  const tokenFee = { amount: "500", address: "0xRavnFee", chainId: 8453, transaction: { to: "0xUSDC", data: "0xfeetransfer", value: "0", chainId: 8453 } };
  const transaction = { to: "0xRouter", data: "0xswap", value: "0", chainId: 8453 };
  const plain = { executionType: "TRANSACTION", quoteToken: "qt-exec", transaction };
  const withFee = { ...plain, approval, fee: tokenFee };
  const pending = { status: "pending", venue: "eco" };
  const success = { status: "success", venue: "eco" };
  const handlers = () => ({
    sendTransaction: vi.fn(async (tx: { data?: string }) => ({ "0xapprove": APPROVAL, "0xswap": SWAP })[tx.data!] ?? FEE),
    waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
  });

  it.each([
    ["a 5xx", httpError(503, "INTERNAL")],
    ["a 429", httpError(429, "RATE_LIMITED", { retryAfterSec: 0 })],
    ["a network failure", new TypeError("fetch failed")],
  ])("retries a status poll that fails with %s instead of rejecting", async (_, failure) => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [plain], status: [failure, success] }) });

    const outcome = await executeAndTrack(client, baseParams, handlers(), { pollIntervalMs: 0 }).catch((e) => e);

    expect(outcome.finalStatus).toEqual(success);
  });

  it("waits out details.retryAfterSec before polling again", async () => {
    vi.useFakeTimers();
    try {
      const client = new RavnClient({ fetch: scriptedFetch({ execute: [plain], status: [httpError(429, "RATE_LIMITED", { retryAfterSec: 5 }), success] }) });
      const statusSpy = vi.spyOn(client, "getStatus");
      const outcome = executeAndTrack(client, baseParams, handlers(), { pollIntervalMs: 10 }).catch((e) => e);

      await vi.advanceTimersByTimeAsync(4_900);
      expect(statusSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(statusSpy).toHaveBeenCalledTimes(2);
      expect((await outcome).finalStatus).toEqual(success);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a status error it can't retry with every hash it sent attached", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [withFee], status: [httpError(400, "INVALID_REQUEST")] }) });

    const err = await executeAndTrack(client, baseParams, handlers(), { pollIntervalMs: 0 }).catch((e) => e);

    expect(err.partial).toMatchObject({ quoteToken: "qt-exec", approvalTxHash: APPROVAL, txHash: SWAP, statusRef: SWAP, feeTxHash: FEE, statusTxHash: FEE });
    expect(err).toBeInstanceOf(ExecuteAndTrackError);
    expect(err.code).toBe("FAILED");
    expect(err.cause).toBeInstanceOf(RavnApiError);
    expect(err.cause.code).toBe("INVALID_REQUEST");
  });

  it("gives up on a status endpoint that keeps failing, hashes attached, rather than spin silently", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [plain], status: [httpError(502, "INTERNAL")] }) });
    const statusSpy = vi.spyOn(client, "getStatus");

    const err = await executeAndTrack(client, baseParams, handlers(), { pollIntervalMs: 0 }).catch((e) => e);

    expect(err.partial).toMatchObject({ txHash: SWAP, statusRef: SWAP });
    expect(err.code).toBe("FAILED");
    expect(statusSpy).toHaveBeenCalledTimes(8);
  });

  it("reports each hash through onProgress the moment it exists, before waiting on it", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [withFee], status: [pending, success] }) });
    const order: string[] = [];
    const h = handlers();
    h.sendTransaction.mockImplementation(async (tx: { data?: string }) => {
      order.push(`send:${tx.data}`);
      return ({ "0xapprove": APPROVAL, "0xswap": SWAP })[tx.data!] ?? FEE;
    });
    h.waitForReceipt.mockImplementation(async (hash: string) => {
      order.push(`wait:${hash.slice(0, 3)}`);
      return receipt(hash);
    });
    const events: ExecuteAndTrackProgress[] = [];

    await executeAndTrack(client, baseParams, h, {
      pollIntervalMs: 0,
      onProgress: (e) => {
        order.push(e.stage);
        events.push(structuredClone(e));
      },
    });

    expect(order).toEqual([
      "send:0xapprove", "approval_sent", "wait:0xe",
      "send:0xswap", "swap_sent", "wait:0xa",
      "send:0xfeetransfer", "fee_sent", "wait:0xf",
      "status", "status", "status",
    ]);
    expect(events[0].partial).toMatchObject({ quoteToken: "qt-exec", approvalTxHash: APPROVAL });
    expect(events[1].partial).toMatchObject({ txHash: SWAP, statusRef: SWAP });
    expect(events[2].partial).toMatchObject({ feeTxHash: FEE, statusTxHash: FEE });
    expect(events[3].partial.lastStatus).toEqual(pending);
    expect(events[5].partial.lastStatus).toEqual(success);
  });

  it("a throwing onProgress never stops the swap or its fee", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [withFee], status: [success] }) });

    const result = await executeAndTrack(client, baseParams, handlers(), { pollIntervalMs: 0, onProgress: () => { throw new Error("db down"); } });

    expect(result).toMatchObject({ txHash: SWAP, feeTxHash: FEE, finalStatus: success });
  });

  it("stops polling on the caller's AbortSignal, hashes attached", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [plain], status: [pending] }) });
    const controller = new AbortController();

    const err = await executeAndTrack(client, baseParams, handlers(), {
      pollIntervalMs: 5,
      signal: controller.signal,
      onProgress: (e) => e.stage === "status" && controller.abort(),
    }).catch((e) => e);

    expect(err.partial).toMatchObject({ txHash: SWAP, statusRef: SWAP, lastStatus: pending });
    expect(err.code).toBe("ABORTED");
  }, 1_000);

  it("never sends the swap once aborted", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [plain], status: [success] }) });
    const controller = new AbortController();
    controller.abort();
    const h = handlers();

    const err = await executeAndTrack(client, baseParams, h, { signal: controller.signal }).catch((e) => e);

    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(err.code).toBe("ABORTED");
  });

  it("gives up after maxWaitMs, even on a status call that never answers", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [plain], status: [pending, HANG] }) });

    const err = await executeAndTrack(client, baseParams, handlers(), { pollIntervalMs: 5, maxWaitMs: 50 }).catch((e) => e);

    expect(err.partial).toMatchObject({ txHash: SWAP, statusRef: SWAP });
    expect(err.code).toBe("TIMEOUT");
  }, 1_000);

  it("retries a rate-limited execute before anything is sent", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [httpError(429, "RATE_LIMITED", { retryAfterSec: 0 }), plain], status: [success] }) });

    const outcome = await executeAndTrack(client, baseParams, handlers(), { pollIntervalMs: 0 }).catch((e) => e);

    expect(outcome.txHash).toBe(SWAP);
  });

  it("retries submitTransaction with the same signed transaction (RAVN never sends it twice)", async () => {
    const execution = { executionType: "TRANSACTION", quoteToken: "qt-exec", statusRef: "ls-swap-id", transaction: { chainId: -2, serialized: "AQID" }, submit: { url: "/api/v1/submit-transaction" } };
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], "submit-transaction": [httpError(502, "BUILD_FAILED"), { txHash: "5igSig" }], status: [success] }) });
    const submitSpy = vi.spyOn(client, "submitTransaction");
    const signSolanaTransaction = vi.fn(async (tx: string) => `signed:${tx}`);

    const outcome = await executeAndTrack(client, baseParams, { ...handlers(), signSolanaTransaction }, { pollIntervalMs: 0 }).catch((e) => e);

    expect(outcome.txHash).toBe("5igSig");
    expect(signSolanaTransaction).toHaveBeenCalledOnce();
    expect(submitSpy.mock.calls).toEqual([[{ quoteToken: "qt-exec", signedTransaction: "signed:AQID" }], [{ quoteToken: "qt-exec", signedTransaction: "signed:AQID" }]]);
  });

  describe("SIGNATURE", () => {
    const execution = { executionType: "SIGNATURE", quoteToken: "qt-exec", approval, typedData: { primaryType: "Order" } };
    const signer = () => ({ ...handlers(), signTypedData: vi.fn(async () => "0xsig" as const) });

    it("retries submitSignature when the venue rate-limits it (nothing was placed)", async () => {
      const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], "submit-signature": [httpError(503, "VENUE_RATE_LIMITED", { retryAfterSec: 0 }), { statusRef: "cow-uid" }], status: [success] }) });

      const outcome = await executeAndTrack(client, baseParams, signer(), { pollIntervalMs: 0 }).catch((e) => e);

      expect(outcome.statusRef).toBe("cow-uid");
    });

    it("never re-submits after BUILD_FAILED (the order may be placed); rejects with what it sent", async () => {
      const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], "submit-signature": [httpError(502, "BUILD_FAILED"), { statusRef: "cow-uid" }] }) });
      const submitSpy = vi.spyOn(client, "submitSignature");

      const err = await executeAndTrack(client, baseParams, signer(), { pollIntervalMs: 0 }).catch((e) => e);

      expect(submitSpy).toHaveBeenCalledOnce();
      expect(err.partial).toMatchObject({ quoteToken: "qt-exec", approvalTxHash: APPROVAL });
      expect(err.cause.code).toBe("BUILD_FAILED");
    });
  });
});

// Claim 2: "expired" means a refund is due, not that the swap is over (Across: hours later).
describe("executeAndTrack: expired", () => {
  const SWAP = `0x${"a".repeat(64)}`;
  const execution = { executionType: "TRANSACTION", quoteToken: "qt-exec", transaction: { to: "0xSpokePool", data: "0xdeposit", value: "0", chainId: 1 } };
  const h = () => ({ sendTransaction: vi.fn(async () => SWAP), waitForReceipt: vi.fn(async (hash: string) => receipt(hash)) });
  const expired = { status: "expired", venue: "across" };
  const refunded = { status: "refunded", venue: "across" };

  it("keeps polling past expired until the refund lands", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], status: [expired, refunded] }) });

    const result = await executeAndTrack(client, baseParams, h(), { pollIntervalMs: 0, expiredPollIntervalMs: 0 });

    expect(result.finalStatus).toEqual(refunded);
  });

  it("polls an expired swap once a minute, not every few seconds", async () => {
    vi.useFakeTimers();
    try {
      const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], status: [expired, refunded] }) });
      const statusSpy = vi.spyOn(client, "getStatus");
      const outcome = executeAndTrack(client, baseParams, h(), { pollIntervalMs: 4_000 }).catch((e) => e);

      await vi.advanceTimersByTimeAsync(59_000);
      expect(statusSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(statusSpy).toHaveBeenCalledTimes(2);
      expect((await outcome).finalStatus).toEqual(refunded);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Claim 5: one confirmation for approve + swap + RAVN's token fee when the wallet can batch.
describe("executeAndTrack: approval batching", () => {
  const [APPROVAL, SWAP, FEE, BATCH] = ["e", "a", "f", "b"].map((c) => `0x${c.repeat(64)}`);
  const approval = { to: "0xUSDC", data: "0xapprove", value: "0", chainId: 8453 };
  const transaction = { to: "0xEco", data: "0xswap", value: "0", chainId: 8453 };
  const tokenFee = { amount: "500", address: "0xRavnFee", chainId: 8453, transaction: { to: "0xUSDC", data: "0xfeetransfer", value: "0", chainId: 8453 } };
  const run = async (execution: unknown, handlers: ExecuteAndTrackHandlers) => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], status: [{ status: "success", venue: "eco" }] }) });
    return executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0 });
  };

  it("puts the approval in the same batch as the swap and a token fee", async () => {
    const handlers = {
      sendTransaction: vi.fn(async () => "never"),
      waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
      sendCalls: vi.fn(async () => [BATCH]), // one atomic transaction carried all three
    };

    const result = await run({ executionType: "TRANSACTION", quoteToken: "qt-exec", approval, transaction, fee: tokenFee }, handlers);

    expect(handlers.sendCalls).toHaveBeenCalledWith([approval, transaction, tokenFee.transaction]);
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
    expect(handlers.waitForReceipt).not.toHaveBeenCalled();
    expect(result).toMatchObject({ approvalTxHash: BATCH, txHash: BATCH, feeTxHash: BATCH, statusTxHash: BATCH });
  });

  it("reads one hash per call when the wallet sent them as separate transactions", async () => {
    const handlers = { sendTransaction: vi.fn(async () => "never"), waitForReceipt: vi.fn(async (hash: string) => receipt(hash)), sendCalls: vi.fn(async () => [APPROVAL, SWAP, FEE]) };

    const result = await run({ executionType: "TRANSACTION", quoteToken: "qt-exec", approval, transaction, fee: tokenFee }, handlers);

    expect(result).toMatchObject({ approvalTxHash: APPROVAL, txHash: SWAP, feeTxHash: FEE });
  });

  // The approval joins a batch only with a fee that may ride in it (`batch`, or a token fee from an
  // API without one): RAVN never batches THORChain (Bifrost ignores a router deposit whose tx.to is
  // the user's own 7702 account) or Bebop (its RFQ settlement needs gas headroom a batch leaves).
  it("keeps the approval its own confirmed step on a swap with no token fee to batch", async () => {
    const handlers = {
      sendTransaction: vi.fn(async (tx: { data?: string }) => (tx.data === "0xapprove" ? APPROVAL : SWAP)),
      waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
      sendCalls: vi.fn(async () => ["never"]),
    };

    const result = await run({ executionType: "TRANSACTION", quoteToken: "qt-exec", approval, transaction }, handlers);

    expect(handlers.sendCalls).not.toHaveBeenCalled();
    expect(handlers.waitForReceipt).toHaveBeenCalledWith(APPROVAL, 8453);
    expect(result).toMatchObject({ approvalTxHash: APPROVAL, txHash: SWAP });
  });
});

// Claim 3: a waitForReceipt resolving to nothing sends no fee, so it must not compile. Checked by
// `npm run typecheck`, not at runtime.
describe("waitForReceipt's type", () => {
  it("refuses an adapter that resolves to nothing; takes viem's, ethers' and web3.js's receipts", () => {
    const sendTransaction = async () => `0x${"a".repeat(64)}`;
    const voidAdapter: ExecuteAndTrackHandlers = {
      sendTransaction,
      // @ts-expect-error resolving to nothing would send no fee: it must not compile
      waitForReceipt: async () => {},
    };
    const booleanAdapter: ExecuteAndTrackHandlers = {
      sendTransaction,
      // @ts-expect-error a boolean isn't a receipt
      waitForReceipt: async () => true,
    };
    // viem / wagmi waitForTransactionReceipt
    const viem: ExecuteAndTrackHandlers = { sendTransaction, waitForReceipt: async (hash) => ({ status: "success" as "success" | "reverted", transactionHash: hash as `0x${string}`, blockNumber: 1n }) };
    // ethers v6 provider.waitForTransaction / tx.wait(): hash, status number | null, may resolve null
    const ethers6: ExecuteAndTrackHandlers = { sendTransaction, waitForReceipt: async (hash) => (Math.random() > 2 ? null : { hash, status: 1 as number | null, index: 0 }) };
    // ethers v5 tx.wait(): status optional
    const ethers5: ExecuteAndTrackHandlers = { sendTransaction, waitForReceipt: async (hash) => ({ transactionHash: hash, status: undefined as number | undefined }) };
    // web3.js v4: status bigint
    const web3: ExecuteAndTrackHandlers = { sendTransaction, waitForReceipt: async (hash) => ({ transactionHash: hash, status: 1n }) };
    expect([voidAdapter, booleanAdapter, viem, ethers6, ethers5, web3]).toHaveLength(6);
  });
});

// ravn-mvp #417: two new execute fields.
describe("executeAndTrack: sandbox executions and approval resets", () => {
  const [RESET, APPROVAL, SWAP, BATCH] = ["d", "e", "a", "b"].map((c) => `0x${c.repeat(64)}`);
  const reset = { to: "0xUSDT", data: "0xapprove0", value: "0" };
  const approval = { to: "0xUSDT", data: "0xapprove", value: "0", chainId: 1, reset };
  const transaction = { to: "0xRouter", data: "0xswap", value: "0", chainId: 1 };
  const tokenFee = { amount: "500", address: "0xRavnFee", chainId: 1, transaction: { to: "0xUSDT", data: "0xfeetransfer", value: "0", chainId: 1 } };
  const sandboxStatus = { status: "success", venue: "across", txHash: "0xsandbox" };
  const wallet = () => ({
    sendTransaction: vi.fn(async (tx: { data?: string }) => ({ "0xapprove0": RESET, "0xapprove": APPROVAL })[tx.data!] ?? SWAP),
    waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
    sendCalls: vi.fn(async () => [BATCH]),
    signTypedData: vi.fn(async () => "0xsig" as const),
  });
  const run = (execution: unknown, handlers: ExecuteAndTrackHandlers, extra: Record<string, unknown[]> = {}) => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], status: [sandboxStatus], ...extra }) });
    return { client, done: executeAndTrack(client, baseParams, handlers, { pollIntervalMs: 0 }) };
  };

  it("never broadcasts a sandbox execution: no approval, swap or fee is sent, and RAVN's synthetic status is polled", async () => {
    const h = wallet();
    const { client, done } = run({ executionType: "TRANSACTION", sandbox: true, quoteToken: "qt-exec", approval, transaction, fee: tokenFee }, h);
    const statusSpy = vi.spyOn(client, "getStatus");

    const result = await done;

    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.sendCalls).not.toHaveBeenCalled();
    expect(result.txHash).toBeUndefined();
    expect(result.finalStatus).toEqual(sandboxStatus);
    expect(statusSpy).toHaveBeenCalledWith("qt-exec", "sandbox", undefined, expect.anything());
  });

  // A venue with no sandbox stand-in returns its live payload: a signature over a real order, or a
  // signed real Solana payment, is a live instrument even though RAVN never forwards it.
  it.each([
    ["a SIGNATURE order", { executionType: "SIGNATURE", sandbox: true, quoteToken: "qt-exec", approval, typedData: { primaryType: "Order" } }],
    ["a broadcastViaRavn Solana payment", { executionType: "TRANSACTION", sandbox: true, quoteToken: "qt-exec", transaction: { chainId: -2, serialized: "AQID" }, submit: { url: "/api/v1/submit-transaction" } }],
  ])("never asks the wallet to sign %s in sandbox, and submits nothing", async (_, execution) => {
    const h = { ...wallet(), signSolanaTransaction: vi.fn(async (tx: string) => `signed:${tx}`) };
    const { client, done } = run(execution, h, { "submit-signature": [{ statusRef: "never" }], "submit-transaction": [{ txHash: "never" }] });
    const submitSignature = vi.spyOn(client, "submitSignature");
    const submitTransaction = vi.spyOn(client, "submitTransaction");

    const result = await done;

    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(h.signSolanaTransaction).not.toHaveBeenCalled();
    expect(submitSignature).not.toHaveBeenCalled();
    expect(submitTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ statusRef: "sandbox", finalStatus: sandboxStatus });
  });

  it("sends and confirms approval.reset (approve to 0, Ethereum USDT) before the approval", async () => {
    const h = wallet();
    const order: string[] = [];
    h.sendTransaction.mockImplementation(async (tx: { data?: string }) => {
      order.push(`send:${tx.data}`);
      return ({ "0xapprove0": RESET, "0xapprove": APPROVAL })[tx.data!] ?? SWAP;
    });
    h.waitForReceipt.mockImplementation(async (hash: string) => {
      order.push(`wait:${hash.slice(0, 3)}`);
      return receipt(hash);
    });

    const { done } = run({ executionType: "TRANSACTION", quoteToken: "qt-exec", approval, transaction }, h);
    const result = await done;

    expect(order).toEqual(["send:0xapprove0", "wait:0xd", "send:0xapprove", "wait:0xe", "send:0xswap"]);
    expect(result.approvalTxHash).toBe(APPROVAL);
  });

  it("puts approval.reset first in a batch", async () => {
    const h = wallet();

    const { done } = run({ executionType: "TRANSACTION", quoteToken: "qt-exec", approval, transaction, fee: tokenFee }, h);
    const result = await done;

    expect(h.sendCalls).toHaveBeenCalledWith([{ ...reset, chainId: 1 }, approval, transaction, tokenFee.transaction]);
    expect(result).toMatchObject({ approvalTxHash: BATCH, txHash: BATCH, feeTxHash: BATCH });
  });
});

// Review of #15, round 1.
describe("executeAndTrack: review fixes", () => {
  const [APPROVAL, SWAP, RESET] = ["e", "a", "d"].map((c) => `0x${c.repeat(64)}`);
  const approval = { to: "0xToken", data: "0xapprove", value: "0", chainId: 1 };
  const transaction = { to: "0xRouter", data: "0xswap", value: "0", chainId: 1 };
  const plain = { executionType: "TRANSACTION", quoteToken: "qt-exec", transaction };
  const success = { status: "success", venue: "relay" };
  const wallet = () => ({
    sendTransaction: vi.fn(async (tx: { data?: string }) => ({ "0xapprove0": RESET, "0xapprove": APPROVAL })[tx.data!] ?? SWAP),
    waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
  });

  it("keeps the signed Solana transaction, and any txHash RAVN names, when submitTransaction keeps failing", async () => {
    const execution = { executionType: "TRANSACTION", quoteToken: "qt-exec", transaction: { chainId: -2, serialized: "AQID" }, submit: { url: "/api/v1/submit-transaction" } };
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], "submit-transaction": [httpError(502, "BUILD_FAILED", { txHash: "5igSig" })] }) });
    const events: string[] = [];

    const err = await executeAndTrack(client, baseParams, { ...wallet(), signSolanaTransaction: async (tx) => `signed:${tx}` }, {
      pollIntervalMs: 0,
      onProgress: (e) => events.push(e.stage),
    }).catch((e) => e);

    expect(err.partial).toMatchObject({ signedTransaction: "signed:AQID", txHash: "5igSig", statusRef: "5igSig" });
    expect(events[0]).toBe("swap_signed");
  });

  it("asks execute again, with the same Idempotency-Key, when its answer was lost or is still being built", async () => {
    const fetchImpl = scriptedFetch({
      execute: [new TypeError("fetch failed"), httpError(503, "UNAVAILABLE", { retryAfterSec: 0 }), plain],
      status: [success],
    });
    const client = new RavnClient({ fetch: fetchImpl });

    const outcome = await executeAndTrack(client, baseParams, wallet(), { pollIntervalMs: 0 });

    expect(outcome.txHash).toBe(SWAP);
    const keys = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => String(url).endsWith("/execute"))
      .map(([, init]) => (init as RequestInit & { headers: Record<string, string> }).headers["Idempotency-Key"]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("asks again after a gateway timeout, and gives up on a lost execute after 4 tries", async () => {
    const fetchImpl = scriptedFetch({ execute: [httpError(504, "INTERNAL"), plain], status: [success] });
    const outcome = await executeAndTrack(new RavnClient({ fetch: fetchImpl }), baseParams, wallet(), { pollIntervalMs: 0 });
    expect(outcome.txHash).toBe(SWAP);

    const offline = scriptedFetch({ execute: [new TypeError("fetch failed")] });
    const err = await executeAndTrack(new RavnClient({ fetch: offline }), baseParams, wallet(), { pollIntervalMs: 0 }).catch((e) => e);
    expect(err.code).toBe("NETWORK_ERROR");
    expect(offline).toHaveBeenCalledTimes(4);
  });

  it("uses the caller's own Idempotency-Key, and never repeats an unexpected execute error", async () => {
    const fetchImpl = scriptedFetch({ execute: [httpError(500, "INTERNAL"), plain] });
    const client = new RavnClient({ fetch: fetchImpl });

    const err = await executeAndTrack(client, { ...baseParams, idempotencyKey: "mine-1" }, wallet(), { pollIntervalMs: 0 }).catch((e) => e);

    expect(err.code).toBe("INTERNAL");
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as RequestInit & { headers: Record<string, string> }).headers["Idempotency-Key"]).toBe("mine-1");
  });

  it("never repeats an execute that failed to build: re-quoting is the fix, and a repeat can open a second venue order", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [httpError(502, "BUILD_FAILED"), plain] }) });
    const executeSpy = vi.spyOn(client, "execute");

    const err = await executeAndTrack(client, baseParams, wallet(), { pollIntervalMs: 0 }).catch((e) => e);

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(err).toBeInstanceOf(RavnApiError);
    expect(err.code).toBe("BUILD_FAILED");
  });

  it("keeps what it knows when sendCalls resolves with no hash", async () => {
    const fee = { amount: "5", address: "0xF", chainId: 1, transaction: { to: "0xUSDC", data: "0xfee", value: "0", chainId: 1 } };
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [{ ...plain, statusRef: "eco-ref", fee }] }) });

    const err = await executeAndTrack(client, baseParams, { ...wallet(), sendCalls: async () => [] }, { pollIntervalMs: 0 }).catch((e) => e);

    expect(err).toBeInstanceOf(ExecuteAndTrackError);
    expect(err.partial).toMatchObject({ quoteToken: "qt-exec", statusRef: "eco-ref" });
  });

  it("asks for no second signature once aborted during the first", async () => {
    const controller = new AbortController();
    const execution = { executionType: "SIGNATURE", quoteToken: "qt-exec", approvalData: { primaryType: "Permit" }, typedData: { primaryType: "Order" } };
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution] }) });
    const signTypedData = vi.fn(async () => {
      controller.abort();
      return "0xsig" as const;
    });

    const err = await executeAndTrack(client, baseParams, { ...wallet(), signTypedData }, { signal: controller.signal }).catch((e) => e);

    expect(signTypedData).toHaveBeenCalledOnce();
    expect(err.code).toBe("ABORTED");
  });

  it("records approval.reset's hash the moment it's sent", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [{ ...plain, approval: { ...approval, reset: { to: "0xToken", data: "0xapprove0", value: "0" } } }] }) });
    const h = wallet();
    h.waitForReceipt.mockRejectedValueOnce(new Error("RPC down"));

    const err = await executeAndTrack(client, baseParams, h, { pollIntervalMs: 0 }).catch((e) => e);

    expect(err.partial.resetTxHash).toBe(RESET);
    expect(err.cause.message).toBe("RPC down");
  });

  it("gives up after maxWaitMs even when a custom fetch ignores the abort signal", async () => {
    let calls = 0;
    const deaf = (async (url: string) => {
      if (url.endsWith("/execute")) return { ok: true, status: 200, json: async () => ({ data: plain }) };
      return calls++ === 0 ? { ok: true, status: 200, json: async () => ({ data: { status: "pending", venue: "relay" } }) } : new Promise(() => {});
    }) as unknown as typeof fetch;
    const client = new RavnClient({ fetch: deaf });

    const err = await executeAndTrack(client, baseParams, wallet(), { pollIntervalMs: 5, maxWaitMs: 50 }).catch((e) => e);

    expect(err.code).toBe("TIMEOUT");
    expect(err.partial.txHash).toBe(SWAP);
  }, 1_000);

  it("sends no swap when aborted while the approval confirms", async () => {
    const controller = new AbortController();
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [{ ...plain, approval }], status: [success] }) });
    const h = wallet();
    h.waitForReceipt.mockImplementation(async (hash: string) => {
      controller.abort();
      return receipt(hash);
    });

    const err = await executeAndTrack(client, baseParams, h, { signal: controller.signal }).catch((e) => e);

    expect(h.sendTransaction).toHaveBeenCalledOnce(); // the approval only
    expect(err.code).toBe("ABORTED");
    expect(err.partial.approvalTxHash).toBe(APPROVAL);
  });

  it("keeps the swap's hash when aborted while the wallet's swap prompt was open", async () => {
    const controller = new AbortController();
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [plain], status: [success] }) });
    const h = wallet();
    h.sendTransaction.mockImplementation(async () => {
      controller.abort();
      return SWAP;
    });

    const err = await executeAndTrack(client, baseParams, h, { signal: controller.signal }).catch((e) => e);

    expect(err.code).toBe("ABORTED");
    expect(err.partial).toMatchObject({ txHash: SWAP, statusRef: SWAP });
  });
});

// Review of #15, round 2.
describe("executeAndTrack: review fixes, round 2", () => {
  const [APPROVAL, SWAP, RESET, BATCH] = ["e", "a", "d", "b"].map((c) => `0x${c.repeat(64)}`);
  const approval = { to: "0xToken", data: "0xapprove", value: "0", chainId: 1 };
  const transaction = { to: "0xRouter", data: "0xswap", value: "0", chainId: 1 };
  const plain = { executionType: "TRANSACTION", quoteToken: "qt-exec", transaction };
  const wallet = () => ({
    sendTransaction: vi.fn(async (tx: { data?: string }) => ({ "0xapprove": APPROVAL })[tx.data!] ?? SWAP),
    waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
  });

  it("an abort ends a receipt wait that never resolves (a dropped approval), hash kept", async () => {
    const controller = new AbortController();
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [{ ...plain, approval }] }) });
    const h = wallet();
    h.waitForReceipt.mockImplementation(() => new Promise(() => {}));
    setTimeout(() => controller.abort(), 20);

    const err = await executeAndTrack(client, baseParams, h, { signal: controller.signal }).catch((e) => e);

    expect(err.code).toBe("ABORTED");
    expect(err.partial.approvalTxHash).toBe(APPROVAL);
    expect(h.sendTransaction).toHaveBeenCalledOnce();
  }, 1_000);

  it("keeps the signed order when submitSignature gets no answer: the venue may hold it", async () => {
    const execution = { executionType: "SIGNATURE", quoteToken: "qt-exec", typedData: { primaryType: "Order" } };
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], "submit-signature": [new TypeError("fetch failed")] }) });
    const stages: string[] = [];

    const err = await executeAndTrack(client, baseParams, { ...wallet(), signTypedData: async () => "0xsig" }, {
      onProgress: (e) => stages.push(e.stage),
    }).catch((e) => e);

    expect(err.partial).toMatchObject({ quoteToken: "qt-exec", signature: "0xsig" });
    expect(err.cause.code).toBe("NETWORK_ERROR");
    expect(stages).toEqual(["swap_signed"]);
  });

  it("retries an execute 429 even without RAVN's error body (a proxy's page)", async () => {
    const page429 = { [FAIL]: { status: 429, code: "INTERNAL" } };
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [page429, plain], status: [{ status: "success", venue: "relay" }] }) });

    const outcome = await executeAndTrack(client, baseParams, wallet(), { pollIntervalMs: 0 }).catch((e) => e);

    expect(outcome.txHash).toBe(SWAP);
  });

  it("never repeats an execute that got no answer without an Idempotency-Key: the first may have opened a venue order", async () => {
    vi.stubGlobal("crypto", {}); // no crypto.randomUUID to make one with
    try {
      const client = new RavnClient({ fetch: scriptedFetch({ execute: [new TypeError("fetch failed"), plain] }) });
      const executeSpy = vi.spyOn(client, "execute");

      const err = await executeAndTrack(client, baseParams, wallet(), { pollIntervalMs: 0 }).catch((e) => e);

      expect(executeSpy).toHaveBeenCalledOnce();
      expect(err.code).toBe("NETWORK_ERROR");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a batched approval.reset's hash", async () => {
    const fee = { amount: "5", address: "0xF", chainId: 1, transaction: { to: "0xUSDT", data: "0xfee", value: "0", chainId: 1 } };
    const reset = { to: "0xUSDT", data: "0xapprove0", value: "0" };
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [{ ...plain, approval: { ...approval, reset }, fee }], status: [{ status: "success", venue: "eco" }] }) });
    const stages: string[] = [];

    const result = await executeAndTrack(client, baseParams, { ...wallet(), sendCalls: async () => [RESET, APPROVAL, BATCH] }, {
      pollIntervalMs: 0,
      onProgress: (e) => stages.push(e.stage),
    });

    expect(result).toMatchObject({ resetTxHash: RESET, approvalTxHash: APPROVAL, txHash: BATCH, feeTxHash: BATCH });
    expect(stages.slice(0, 2)).toEqual(["reset_sent", "approval_sent"]);
  });

  it("a DEPOSIT honours an abort that arrived during execute", async () => {
    const controller = new AbortController();
    const deposit = { executionType: "DEPOSIT", quoteToken: "qt-exec", deposit: { address: "dep", amount: "1" } };
    const fetchImpl = (async () => {
      controller.abort();
      return { ok: true, status: 200, json: async () => ({ data: deposit }) };
    }) as unknown as typeof fetch;

    const err = await executeAndTrack(new RavnClient({ fetch: fetchImpl }), baseParams, wallet(), { signal: controller.signal }).catch((e) => e);

    expect(err.code).toBe("ABORTED");
  });
});

// Review of #15, round 3.
describe("executeAndTrack: review fixes, round 3", () => {
  const [APPROVAL, SWAP, FEE] = ["e", "a", "f"].map((c) => `0x${c.repeat(64)}`);
  const approval = { to: "0xToken", data: "0xapprove", value: "0", chainId: 1 };
  const transaction = { to: "0xRouter", data: "0xswap", value: "0", chainId: 1 };
  const coinFee = { amount: "5", address: "0xF", chainId: 1, transaction: { to: "0xF", data: "0xfee", value: "5", chainId: 1 } };
  const plain = { executionType: "TRANSACTION", quoteToken: "qt-exec", transaction };
  const wallet = () => ({
    sendTransaction: vi.fn(async (tx: { data?: string }) => ({ "0xapprove": APPROVAL, "0xswap": SWAP })[tx.data!] ?? FEE),
    waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
  });
  // Unhandled rejections, collected while `run` executes and shortly after.
  const unhandledDuring = async (run: () => Promise<unknown>): Promise<unknown[]> => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await run();
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    return seen;
  };

  it("a receipt that rejects after an abort is never an unhandled rejection", async () => {
    const controller = new AbortController();
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [{ ...plain, approval }] }) });
    // Plain functions, not vi.fn: a mock attaches its own handler to the promise it returns, which
    // would hide exactly the unhandled rejection this checks for.
    const h: ExecuteAndTrackHandlers = {
      sendTransaction: async () => {
        controller.abort(); // the user cancels; the wallet sends anyway
        return APPROVAL;
      },
      waitForReceipt: () => new Promise((_, reject) => setTimeout(() => reject(new Error("reverted")), 10)),
    };
    let err: ExecuteAndTrackError | undefined;

    const unhandled = await unhandledDuring(async () => {
      err = await executeAndTrack(client, baseParams, h, { signal: controller.signal }).catch((e) => e);
    });

    expect(unhandled).toEqual([]);
    expect(err?.code).toBe("ABORTED");
    expect(err?.partial.approvalTxHash).toBe(APPROVAL);
  });

  it("an async onProgress that rejects is never an unhandled rejection, and never stops the swap", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [plain], status: [{ status: "success", venue: "relay" }] }) });
    let txHash: string | undefined;

    const unhandled = await unhandledDuring(async () => {
      ({ txHash } = await executeAndTrack(client, baseParams, wallet(), { pollIntervalMs: 0, onProgress: async () => { throw new Error("db down"); } }));
    });

    expect(unhandled).toEqual([]);
    expect(txHash).toBe(SWAP);
  });

  it.each([
    ["the swap's receipt (before the fee)", SWAP, undefined],
    ["the fee's receipt", FEE, FEE],
  ])("an abort ends a wait on %s that never resolves, hashes kept", async (_, stuckOn, feeTxHash) => {
    const controller = new AbortController();
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [{ ...plain, fee: coinFee }] }) });
    const h = wallet();
    h.waitForReceipt.mockImplementation(async (hash: string) => {
      if (hash !== stuckOn) return receipt(hash);
      setTimeout(() => controller.abort(), 10);
      return new Promise(() => {});
    });

    const err = await executeAndTrack(client, baseParams, h, { signal: controller.signal }).catch((e) => e);

    expect(err.code).toBe("ABORTED");
    expect(err.partial.txHash).toBe(SWAP);
    expect(err.partial.feeTxHash).toBe(feeTxHash);
    expect(h.sendTransaction).toHaveBeenCalledTimes(feeTxHash ? 2 : 1);
  }, 1_000);

  it("rejects ABORTED, not a feeError, when aborted before the fee with polling off", async () => {
    const controller = new AbortController();
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [{ ...plain, fee: coinFee }] }) });
    const h = wallet();
    h.waitForReceipt.mockImplementation(async (hash: string) => {
      controller.abort();
      return receipt(hash);
    });

    const err = await executeAndTrack(client, baseParams, h, { signal: controller.signal, pollUntilTerminal: false }).catch((e) => e);

    expect(err.code).toBe("ABORTED");
    expect(err.partial.txHash).toBe(SWAP);
    expect(h.sendTransaction).toHaveBeenCalledOnce();
  });

  it("an abort ends an execute that never answers", async () => {
    const controller = new AbortController();
    const client = new RavnClient({ fetch: (() => new Promise(() => {})) as unknown as typeof fetch });
    setTimeout(() => controller.abort(), 20);

    const err = await executeAndTrack(client, baseParams, wallet(), { signal: controller.signal }).catch((e) => e);

    expect(err.code).toBe("ABORTED");
  }, 1_000);
});

// Review of #15, round 4, and not_found (RAVN's server treats only success/refunded/failed as final).
describe("executeAndTrack: review fixes, round 4", () => {
  const SWAP = `0x${"a".repeat(64)}`;
  const approval = { to: "0xToken", data: "0xapprove", value: "0", chainId: 1 };
  const plain = { executionType: "TRANSACTION", quoteToken: "qt-exec", transaction: { to: "0xRouter", data: "0xswap", value: "0", chainId: 1 } };

  it("an abort ends an allowance read that never answers, nothing sent", async () => {
    const controller = new AbortController();
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [{ ...plain, approval }] }) });
    const sendTransaction = vi.fn(async () => SWAP);
    setTimeout(() => controller.abort(), 20);

    const err = await executeAndTrack(client, baseParams, {
      sendTransaction,
      waitForReceipt: async (hash) => receipt(hash),
      hasAllowance: () => new Promise(() => {}),
    }, { signal: controller.signal }).catch((e) => e);

    expect(err.code).toBe("ABORTED");
    expect(sendTransaction).not.toHaveBeenCalled();
  }, 1_000);

  it("takes a JS waitForReceipt that returns the receipt itself, not a promise", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [{ ...plain, approval }], status: [{ status: "success", venue: "relay" }] }) });
    const sendTransaction = vi.fn(async (tx: { data?: string }) => (tx.data === "0xapprove" ? `0x${"e".repeat(64)}` : SWAP));

    const result = await executeAndTrack(client, baseParams, {
      sendTransaction,
      waitForReceipt: ((hash: string) => receipt(hash)) as never,
    }, { pollIntervalMs: 0 });

    expect(result.txHash).toBe(SWAP);
  });

  it("keeps polling past not_found: the venue may not have seen the swap yet", async () => {
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [plain], status: [{ status: "not_found", venue: "relay" }, { status: "success", venue: "relay" }] }) });

    const result = await executeAndTrack(client, baseParams, { sendTransaction: async () => SWAP, waitForReceipt: async (hash) => receipt(hash) }, { pollIntervalMs: 0 });

    expect(result.finalStatus?.status).toBe("success");
  });
});

// Review of #15, round 5.
describe("executeAndTrack: review fixes, round 5", () => {
  it("calls a class-instance wallet's handlers as methods (signTypedData keeps its `this`)", async () => {
    class Wallet {
      private readonly signer = "0xsig" as const;
      async sendTransaction() {
        return `0x${"a".repeat(64)}`;
      }
      async waitForReceipt(hash: string) {
        return receipt(hash);
      }
      async signTypedData() {
        return this.signer;
      }
    }
    const execution = { executionType: "SIGNATURE", quoteToken: "qt-exec", approvalData: { primaryType: "Permit" }, typedData: { primaryType: "Order" } };
    const client = new RavnClient({ fetch: scriptedFetch({ execute: [execution], "submit-signature": [{ statusRef: "cow-uid" }], status: [{ status: "success", venue: "cow" }] }) });
    const submitSpy = vi.spyOn(client, "submitSignature");

    const result = await executeAndTrack(client, baseParams, new Wallet(), { pollIntervalMs: 0 });

    expect(result.statusRef).toBe("cow-uid");
    expect(submitSpy).toHaveBeenCalledWith({ quoteToken: "qt-exec", signature: "0xsig", approvalSignature: "0xsig" });
  });
});
