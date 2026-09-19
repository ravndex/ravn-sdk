import { describe, expect, it, vi } from "vitest";
import { RavnClient } from "./client";
import { executeAndTrack } from "./execute-and-track";

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

describe("executeAndTrack — TRANSACTION", () => {
  it("waits for the approval receipt before sending the main tx, then polls to terminal", async () => {
    const fetchImpl = scriptedFetch({
      execute: [
        {
          executionType: "TRANSACTION",
          approval: { to: "0xSpender", data: "0xapprove", value: "0", chainId: 1 },
          transaction: { to: "0xRouter", data: "0xswap", value: "0", chainId: 1 },
        },
      ],
      status: [{ status: "pending", venue: "across" }, { status: "success", venue: "across" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });

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
  });

  it("skips the approval step entirely when the execution has none", async () => {
    const fetchImpl = scriptedFetch({
      execute: [{ executionType: "TRANSACTION", transaction: { to: "0xRouter", data: "0xswap" } }],
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
          executionType: "TRANSACTION",
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
      execute: [{ executionType: "TRANSACTION", transaction: { to: "0xRouter", data: "0xswap" } }],
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

describe("executeAndTrack — SIGNATURE", () => {
  it("signs the approval and trade typed data, submits, then polls", async () => {
    const fetchImpl = scriptedFetch({
      execute: [
        {
          executionType: "SIGNATURE",
          approvalData: { domain: {}, types: {}, primaryType: "Permit", message: {} },
          typedData: { domain: {}, types: {}, primaryType: "Order", message: {} },
          submit: { url: "/submit-signature" },
        },
      ],
      "submit-signature": [{ statusRef: "ref-1" }],
      status: [{ status: "success", venue: "0x" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });
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
  });

  it("sends and confirms the on-chain approval before signing anything — CoW/Bebop's vault relayer and Permit2 still pull via transferFrom even on a signed order", async () => {
    const fetchImpl = scriptedFetch({
      execute: [
        {
          executionType: "SIGNATURE",
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
      execute: [{ executionType: "SIGNATURE", typedData: {}, submit: { url: "/submit-signature" } }],
    });
    const client = new RavnClient({ fetch: fetchImpl });

    await expect(
      executeAndTrack(client, baseParams, { sendTransaction: vi.fn(), waitForReceipt: vi.fn() })
    ).rejects.toThrow(/signTypedData/);
  });

  it("checks for missing typedData before ever prompting a signature for approvalData", async () => {
    const fetchImpl = scriptedFetch({
      execute: [
        { executionType: "SIGNATURE", approvalData: { primaryType: "Permit" }, submit: { url: "/submit-signature" } },
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

describe("executeAndTrack — DEPOSIT", () => {
  it("returns immediately without polling — the deposit itself happens out-of-band", async () => {
    const fetchImpl = scriptedFetch({
      execute: [{ executionType: "DEPOSIT", deposit: { address: "bc1q...", amount: "100000" }, statusRef: "dep-1" }],
    });
    const client = new RavnClient({ fetch: fetchImpl });
    const getStatusSpy = vi.spyOn(client, "getStatus");

    const result = await executeAndTrack(client, baseParams, { sendTransaction: vi.fn(), waitForReceipt: vi.fn() });

    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(result.statusRef).toBe("dep-1");
    expect(result.finalStatus).toBeUndefined();
  });
});
