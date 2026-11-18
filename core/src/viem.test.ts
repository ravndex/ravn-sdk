import { describe, expect, it, vi } from "vitest";
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { base } from "viem/chains";
import { RavnClient } from "./client";
import { executeAndTrack, SentUnclearError } from "./execute-and-track";
import { viemHandlers } from "./viem";
import type { ViemPublicClient, ViemWalletClient } from "./viem";

type Hex = `0x${string}`;
const BASE = 8453;
const SPENDER = `0x${"5".repeat(40)}` as Hex;
const [APPROVE_HASH, SWAP_HASH] = ["e", "a"].map((c) => `0x${c.repeat(64)}` as Hex);
// Batch support is remembered per wallet + chain for the page's life: a new wallet per test.
let n = 0;
const nextAccount = () => ({ address: `0x${(++n).toString(16).padStart(40, "0")}` as Hex });

function wallet(overrides: Partial<Record<keyof ViemWalletClient, unknown>> = {}, chainId = BASE) {
  let on = chainId;
  const w = {
    account: nextAccount(),
    getChainId: vi.fn(async () => on),
    switchChain: vi.fn(async ({ id }: { id: number }) => void (on = id)),
    sendTransaction: vi.fn(async (args: { data: Hex }) => (args.data === "0xapprove" ? APPROVE_HASH : SWAP_HASH)),
    signTypedData: vi.fn(async () => "0xsig" as Hex),
    signMessage: vi.fn(async () => "0xmsg" as Hex),
    getCapabilities: vi.fn(async () => ({ atomic: { status: "supported" } })),
    sendCalls: vi.fn(async () => ({ id: "batch-1" })),
    waitForCallsStatus: vi.fn(async () => ({ status: "success", statusCode: 200, receipts: [{ transactionHash: SWAP_HASH }] })),
  };
  return { ...w, ...overrides } as typeof w;
}

function publicClient(overrides: Partial<Record<keyof ViemPublicClient, unknown>> = {}, chainId = BASE) {
  const p = {
    chain: { id: chainId, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } },
    estimateGas: vi.fn(async () => 100_000n),
    call: vi.fn(async () => ({ data: `0x${(0n).toString(16).padStart(64, "0")}` as Hex })),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({ status: "success", transactionHash: hash })),
    getBlock: vi.fn(async () => ({ timestamp: 1_000n, number: 10n, baseFeePerGas: 1_000_000_000n })),
    getBalance: vi.fn(async () => 10n ** 18n),
    getCode: vi.fn(async () => undefined),
    estimateMaxPriorityFeePerGas: vi.fn(async () => 0n),
    simulateBlocks: vi.fn(async ({ blocks }: { blocks: { blockOverrides: unknown; calls: unknown[] }[] }) => [{ calls: blocks[0].calls.map(() => ({ status: "success", gasUsed: 100_000n })) }]),
  };
  return { ...p, ...overrides } as typeof p;
}

const swap = { to: "0x0000000000000000000000000000000000000001", data: "0xswap", value: "0", chainId: BASE };
const approve = { to: "0x0000000000000000000000000000000000000002", data: "0xapprove", value: "0", chainId: BASE };
const handlersFor = (w: ReturnType<typeof wallet>, p: ReturnType<typeof publicClient>) => viemHandlers({ walletClient: w, publicClient: p });

describe("viemHandlers: sendTransaction", () => {
  it("switches the wallet to the swap's chain, reads it back, and refuses if it didn't move", async () => {
    const w = wallet({}, 1);
    await handlersFor(w, publicClient()).sendTransaction(swap);
    expect(w.switchChain).toHaveBeenCalledWith({ id: BASE });
    expect(w.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ chain: expect.objectContaining({ id: BASE }) }));

    const stuck = wallet({ switchChain: vi.fn(async () => {}) }, 1);
    await expect(handlersFor(stuck, publicClient()).sendTransaction(swap)).rejects.toThrow(/on chain 1, not 8453, so nothing was sent/);
    expect(stuck.sendTransaction).not.toHaveBeenCalled();
  });

  it("sends with RAVN's gas limit when given, else 1.5× its own estimate", async () => {
    const w = wallet();
    const p = publicClient();
    const h = handlersFor(w, p);
    await h.sendTransaction({ ...swap, gasLimit: "321000" });
    expect(p.estimateGas).not.toHaveBeenCalled();
    expect(w.sendTransaction).toHaveBeenLastCalledWith(expect.objectContaining({ gas: 321_000n, to: swap.to, data: "0xswap", value: 0n }));
    await h.sendTransaction(swap);
    expect(w.sendTransaction).toHaveBeenLastCalledWith(expect.objectContaining({ gas: 150_000n }));
  });

  it("tries the estimate 3 times, 400 ms apart, then refuses with nothing sent", async () => {
    vi.useFakeTimers();
    try {
      const w = wallet();
      const p = publicClient({ estimateGas: vi.fn(async () => Promise.reject(new Error("execution reverted"))) });
      const sent = handlersFor(w, p).sendTransaction(swap).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(800);
      expect(((await sent) as Error).message).toMatch(/Couldn't confirm this transaction will succeed, so nothing was sent/);
      expect(p.estimateGas).toHaveBeenCalledTimes(3);
      expect(w.sendTransaction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("on HyperEVM: 10% over its own estimate, and nothing over its 3M-gas blocks", async () => {
    const w = wallet({}, 999);
    await handlersFor(w, publicClient({}, 999)).sendTransaction({ ...swap, chainId: 999, gasLimit: "999999" });
    expect(w.sendTransaction).toHaveBeenLastCalledWith(expect.objectContaining({ gas: 110_000n }));
    const heavy = publicClient({ estimateGas: vi.fn(async () => 2_800_000n) }, 999);
    await expect(handlersFor(wallet({}, 999), heavy).sendTransaction({ ...swap, chainId: 999 })).rejects.toThrow(/too heavy for HyperEVM's blocks/);
  });

  it("caps the fee at twice the base fee on Robinhood Chain and Elysium", async () => {
    const w = wallet({}, 4663);
    await handlersFor(w, publicClient({}, 4663)).sendTransaction({ ...swap, chainId: 4663 });
    expect(w.sendTransaction).toHaveBeenLastCalledWith(expect.objectContaining({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 0n }));
    const elsewhere = wallet();
    await handlersFor(elsewhere, publicClient()).sendTransaction(swap);
    expect(elsewhere.sendTransaction.mock.calls[0][0]).not.toHaveProperty("maxFeePerGas");
  });

  it("says how much gas money is missing when the wallet refuses for it", async () => {
    const insufficient = Object.assign(new Error("insufficient funds"), {
      name: "TransactionExecutionError",
      details: "insufficient funds for gas * price + value: have 1000000000000000 want 2600000000000000",
      cause: { name: "InsufficientFundsError" },
    });
    const w = wallet({ sendTransaction: vi.fn(async () => Promise.reject(insufficient)) });
    await expect(handlersFor(w, publicClient()).sendTransaction(swap)).rejects.toThrow("This wallet needs about 0.0016 more ETH to pay the network fee, so nothing was sent.");
  });

  it("refuses a Solana transaction and a chain without a public client, sending nothing", async () => {
    const w = wallet();
    await expect(handlersFor(w, publicClient()).sendTransaction({ chainId: -2, serialized: "AQID" })).rejects.toThrow(/Solana add-on/);
    await expect(viemHandlers({ walletClient: w, publicClient: () => undefined }).sendTransaction(swap)).rejects.toThrow(/No public client for chain 8453/);
    // One client, for another chain, isn't used.
    await expect(viemHandlers({ walletClient: w, publicClient: publicClient({}, 1) }).sendTransaction(swap)).rejects.toThrow(/No public client/);
    expect(w.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("viemHandlers: receipts and allowances", () => {
  it("reads a cancelled or replaced transaction as failed, a repriced one as it landed", async () => {
    const replacedBy = (reason: string) =>
      publicClient({
        waitForTransactionReceipt: vi.fn(async ({ onReplaced }: { onReplaced?: (r: { reason: string }) => void }) => {
          onReplaced?.({ reason });
          return { status: "success", transactionHash: SWAP_HASH };
        }),
      });
    await expect(handlersFor(wallet(), replacedBy("cancelled")).waitForReceipt(APPROVE_HASH, BASE)).resolves.toEqual({ status: "reverted", transactionHash: APPROVE_HASH });
    await expect(handlersFor(wallet(), replacedBy("repriced")).waitForReceipt(APPROVE_HASH, BASE)).resolves.toEqual({ status: "success", transactionHash: SWAP_HASH });
  });

  it("reads allowance(owner, spender) and compares it with what the swap needs", async () => {
    const w = wallet();
    const enough = publicClient({ call: vi.fn(async () => ({ data: `0x${(500n).toString(16).padStart(64, "0")}` as Hex })) });
    const h = handlersFor(w, enough);
    const approval = { ...approve, spender: SPENDER, amount: "500" };
    await expect(h.hasAllowance!(approval)).resolves.toBe(true);
    expect(enough.call).toHaveBeenCalledWith({ to: approve.to, data: `0xdd62ed3e${w.account.address.slice(2).padStart(64, "0")}${SPENDER.slice(2).padStart(64, "0")}` });
    await expect(h.hasAllowance!({ ...approval, amount: "501" })).resolves.toBe(false);
    await expect(h.hasAllowance!({ ...approval, spender: undefined })).resolves.toBe(false);
    const broken = publicClient({ call: vi.fn(async () => Promise.reject(new Error("rpc down"))) });
    await expect(handlersFor(w, broken).hasAllowance!(approval)).resolves.toBe(false);
  });
});

describe("viemHandlers: preflight (gas money for approvals and the swap)", () => {
  // Approve 50k + swap 100k (sent with 150k) at twice a 1 gwei base fee: 0.0004 ETH.
  const simulated = (gas: bigint[]) => vi.fn(async () => [{ calls: gas.map((gasUsed) => ({ status: "success", gasUsed })) }]);

  it("refuses before the approval when the wallet can't also pay for the swap", async () => {
    const p = publicClient({ simulateBlocks: simulated([50_000n, 100_000n]), getBalance: vi.fn(async () => 300_000_000_000_000n) });
    await expect(handlersFor(wallet(), p).preflight!([approve, swap])).rejects.toThrow("This wallet needs about 0.0001 more ETH");
    const rich = publicClient({ simulateBlocks: simulated([50_000n, 100_000n]), getBalance: vi.fn(async () => 400_000_000_000_000n) });
    await expect(handlersFor(wallet(), rich).preflight!([approve, swap])).resolves.toBeUndefined();
  });

  it("counts the swap at RAVN's gas limit and its value", async () => {
    const p = publicClient({ simulateBlocks: simulated([50_000n, 100_000n]), getBalance: vi.fn(async () => 10n ** 15n) });
    // (50k + 400k) × 2 gwei = 0.0009 ETH, plus 0.0002 ETH sent: 0.0011 against 0.001.
    await expect(handlersFor(wallet(), p).preflight!([approve, { ...swap, gasLimit: "400000", value: "200000000000000" }])).rejects.toThrow(/about 0.0001 more ETH/);
  });

  it("checks nothing for a swap alone, a contract account (a 7702 one is checked), Monad, or what it can't read", async () => {
    const poor = { simulateBlocks: simulated([50_000n, 100_000n]), getBalance: vi.fn(async () => 0n) };
    await expect(handlersFor(wallet(), publicClient(poor)).preflight!([swap])).resolves.toBeUndefined();
    await expect(handlersFor(wallet(), publicClient({ ...poor, getCode: vi.fn(async () => "0x6080" as Hex) })).preflight!([approve, swap])).resolves.toBeUndefined();
    await expect(handlersFor(wallet(), publicClient({ ...poor, getCode: vi.fn(async () => `0xef0100${"1".repeat(40)}` as Hex) })).preflight!([approve, swap])).rejects.toThrow(/more ETH/);
    const monad = [{ ...approve, chainId: 143 }, { ...swap, chainId: 143 }];
    await expect(handlersFor(wallet({}, 143), publicClient(poor, 143)).preflight!(monad)).resolves.toBeUndefined();
    await expect(handlersFor(wallet(), publicClient({ ...poor, simulateBlocks: vi.fn(async () => Promise.reject(new Error("no eth_simulateV1"))) })).preflight!([approve, swap])).resolves.toBeUndefined();
    const reverting = vi.fn(async () => [{ calls: [{ status: "success", gasUsed: 50_000n }, { status: "failure", gasUsed: 30_000n }] }]);
    await expect(handlersFor(wallet(), publicClient({ ...poor, simulateBlocks: reverting })).preflight!([approve, swap])).resolves.toBeUndefined();
  });
});

describe("viemHandlers: sendCalls (one confirmation)", () => {
  const batch = [approve, swap];

  it("sends an atomic batch simulated at the chain's next block, and returns its hashes", async () => {
    const w = wallet();
    const p = publicClient();
    await expect(handlersFor(w, p).sendCalls!(batch)).resolves.toEqual([SWAP_HASH]);
    expect(w.sendCalls).toHaveBeenCalledWith(expect.objectContaining({ forceAtomic: true, calls: [{ to: approve.to, data: "0xapprove", value: 0n }, { to: swap.to, data: "0xswap", value: 0n }] }));
    expect(p.simulateBlocks.mock.calls[0][0].blocks[0].blockOverrides).toEqual({ time: 1_002n });
    expect(w.waitForCallsStatus).toHaveBeenCalledWith({ id: "batch-1", timeout: 600_000 });
  });

  it("goes one by one (null), with no prompt, where the wallet can't batch, the batch doesn't simulate, or a call is too heavy", async () => {
    const cases = [
      [wallet({ getCapabilities: vi.fn(async () => ({ atomic: { status: "unsupported" } })) }), publicClient()],
      [wallet({ getCapabilities: vi.fn(async () => Promise.reject(new Error("method not found"))) }), publicClient()],
      [wallet(), publicClient({ simulateBlocks: vi.fn(async () => [{ calls: [{ status: "success", gasUsed: 50_000n }, { status: "failure", gasUsed: 1n }] }]) })],
      [wallet(), publicClient({ simulateBlocks: vi.fn(async () => [{ calls: [{ status: "success", gasUsed: 50_000n }, { status: "success", gasUsed: 400_001n }] }]) })],
      [wallet(), publicClient({ simulateBlocks: undefined })],
      [wallet({ sendCalls: undefined }), publicClient()],
    ] as const;
    for (const [w, p] of cases) {
      await expect(handlersFor(w, p).sendCalls!(batch)).resolves.toBeNull();
      if (w.sendCalls) expect(w.sendCalls).not.toHaveBeenCalled();
    }
  });

  it("asks the wallet's capabilities once per wallet and chain", async () => {
    const w = wallet();
    const h = handlersFor(w, publicClient());
    await h.sendCalls!(batch);
    await h.sendCalls!(batch);
    expect(w.getCapabilities).toHaveBeenCalledOnce();
  });

  it("falls back on a refusal before any prompt; a declined upgrade, for the rest of the session", async () => {
    const refused = wallet({ sendCalls: vi.fn(async () => Promise.reject(Object.assign(new Error("unsupported"), { code: 5710 }))) });
    await expect(handlersFor(refused, publicClient()).sendCalls!(batch)).resolves.toBeNull();

    const declined = wallet({ getCapabilities: vi.fn(async () => ({ atomic: { status: "ready" } })), sendCalls: vi.fn(async () => Promise.reject(Object.assign(new Error("upgrade rejected"), { code: 5750 }))) });
    const h = handlersFor(declined, publicClient());
    await expect(h.sendCalls!(batch)).resolves.toBeNull();
    await expect(h.sendCalls!(batch)).resolves.toBeNull();
    expect(declined.sendCalls).toHaveBeenCalledOnce();
  });

  it("passes a cancel on as it is (nothing sent); on an upgrade prompt, never offers it again", async () => {
    const cancel = Object.assign(new Error("User rejected the request."), { code: 4001 });
    const w = wallet({ getCapabilities: vi.fn(async () => ({ atomic: { status: "ready" } })), sendCalls: vi.fn(async () => Promise.reject(cancel)) });
    const h = handlersFor(w, publicClient());
    await expect(h.sendCalls!(batch)).rejects.toBe(cancel);
    await expect(h.sendCalls!(batch)).resolves.toBeNull();
  });

  it("anything else after the prompt may have gone out: SentUnclearError, and one by one next time", async () => {
    const w = wallet({ sendCalls: vi.fn(async () => Promise.reject(new Error("WalletConnect timed out"))) });
    const h = handlersFor(w, publicClient());
    await expect(h.sendCalls!(batch)).rejects.toBeInstanceOf(SentUnclearError);
    await expect(h.sendCalls!(batch)).resolves.toBeNull();

    const silent = wallet({ waitForCallsStatus: vi.fn(async () => Promise.reject(new Error("timed out"))) });
    await expect(handlersFor(silent, publicClient()).sendCalls!(batch)).rejects.toThrow(/may still go through.*batch-1/);
  });

  it("a batch the wallet never sent (400, no receipts) says so; one that ran and reverted gives its hashes", async () => {
    const never = wallet({ waitForCallsStatus: vi.fn(async () => ({ status: "failure", statusCode: 400 })) });
    const error = await handlersFor(never, publicClient()).sendCalls!(batch).catch((e) => e);
    expect(error.message).toMatch(/nothing reached the chain/);
    expect(error).not.toBeInstanceOf(SentUnclearError);

    const reverted = wallet({ waitForCallsStatus: vi.fn(async () => ({ status: "failure", statusCode: 500, receipts: [{ transactionHash: SWAP_HASH }] })) });
    await expect(handlersFor(reverted, publicClient()).sendCalls!(batch)).resolves.toEqual([SWAP_HASH]);
  });
});

describe("viemHandlers: signing", () => {
  it("signs typed data on its domain's chain, leaving EIP712Domain to viem", async () => {
    const w = wallet({}, 1);
    const typedData = { domain: { name: "CoW", chainId: BASE }, types: { EIP712Domain: [], Order: [] }, primaryType: "Order", message: { a: 1 } };
    await handlersFor(w, publicClient()).signTypedData!(typedData);
    expect(w.switchChain).toHaveBeenCalledWith({ id: BASE });
    expect(w.signTypedData).toHaveBeenCalledWith({ domain: typedData.domain, types: { Order: [] }, primaryType: "Order", message: { a: 1 } });
  });
});

describe("viemHandlers with executeAndTrack", () => {
  const execution = (batch: boolean) => ({
    executionType: "TRANSACTION",
    quoteToken: "qt-exec",
    approval: { ...approve, spender: SPENDER, amount: "1000" },
    transaction: { ...swap, gasLimit: "150000" },
    batch,
  });
  const run = (handlers: ReturnType<typeof viemHandlers>, exec: unknown) => {
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: url.includes("execute") ? exec : { status: "success", venue: "kyberswap" } }),
    })) as unknown as typeof globalThis.fetch;
    return executeAndTrack(new RavnClient({ guard: false, fetch }), { quoteToken: "qt-1" }, handlers, { pollIntervalMs: 0 });
  };

  it("an approval and the swap in one confirmation where RAVN and the wallet allow it", async () => {
    const w = wallet();
    const r = await run(handlersFor(w, publicClient()), execution(true));
    expect(w.sendCalls).toHaveBeenCalledOnce();
    expect(w.sendTransaction).not.toHaveBeenCalled();
    expect(r).toMatchObject({ approvalTxHash: SWAP_HASH, txHash: SWAP_HASH });
  });

  it("one by one where the wallet can't batch: gas checked first, the approval confirmed, then the swap", async () => {
    const w = wallet({ getCapabilities: vi.fn(async () => ({ atomic: { status: "unsupported" } })) });
    const p = publicClient();
    const r = await run(handlersFor(w, p), execution(true));
    expect(p.simulateBlocks).toHaveBeenCalledOnce(); // the preflight
    expect(w.sendTransaction.mock.calls.map((c) => c[0].data)).toEqual(["0xapprove", "0xswap"]);
    expect(p.waitForTransactionReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: APPROVE_HASH }));
    expect(r).toMatchObject({ approvalTxHash: APPROVE_HASH, txHash: SWAP_HASH });
  });

  it("one by one where RAVN says no batch, and no approval at all when the allowance is there", async () => {
    const w = wallet();
    await run(handlersFor(w, publicClient()), execution(false));
    expect(w.sendCalls).not.toHaveBeenCalled();
    const covered = wallet();
    const p = publicClient({ call: vi.fn(async () => ({ data: `0x${(1000n).toString(16).padStart(64, "0")}` as Hex })) });
    const r = await run(handlersFor(covered, p), execution(true));
    expect(covered.sendTransaction.mock.calls.map((c) => c[0].data)).toEqual(["0xswap"]);
    expect(r.approvalTxHash).toBeUndefined();
  });

  it("a gas-money refusal stops the swap before the approval spends anything", async () => {
    const w = wallet({ getCapabilities: vi.fn(async () => ({ atomic: { status: "unsupported" } })) });
    const p = publicClient({ getBalance: vi.fn(async () => 1n) });
    await expect(run(handlersFor(w, p), execution(true))).rejects.toThrow(/more ETH to pay the network fee, so nothing was sent/);
    expect(w.sendTransaction).not.toHaveBeenCalled();
  });
});

// Compiles against real viem clients (`npm run typecheck`): wagmi's getWalletClient/getPublicClient
// return these same types.
describe("viem's own clients fit", () => {
  it("takes a viem wallet client and public client as they are", () => {
    const walletClient = createWalletClient({ account: `0x${"1".repeat(40)}`, chain: base, transport: custom({ request: async () => null }) });
    const publicClient = createPublicClient({ chain: base, transport: http("http://127.0.0.1:1") });
    const handlers = viemHandlers({ walletClient, publicClient });
    viemHandlers({ walletClient: async () => walletClient, publicClient: (chainId: number) => (chainId === base.id ? publicClient : undefined) });
    expect(handlers.batchApprovals).toBe(true);
  });
});
