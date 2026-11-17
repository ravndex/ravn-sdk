import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RavnClient } from "./client";
import type { RavnClientConfig } from "./client";
import { TRACK_WITHIN_MS } from "./dev-warnings";
import { executeAndTrack } from "./execute-and-track";
import type { ExecuteAndTrackHandlers } from "./execute-and-track";

// Each path answers its list in order, then repeats the last.
function api(answers: Record<string, unknown[]>) {
  const n: Record<string, number> = {};
  return vi.fn(async (url: string) => {
    const key = new URL(url).pathname.split("/").pop()!;
    const list = answers[key];
    const i = n[key] ?? 0;
    n[key] = i + 1;
    return { ok: true, status: 200, json: async () => ({ data: list[Math.min(i, list.length - 1)] }) };
  }) as unknown as typeof fetch;
}

const SWAP = `0x${"a".repeat(64)}`;
const FEE = `0x${"f".repeat(64)}`;
const swapTx = { to: "0xRouter", data: "0xswap", value: "0", chainId: 1 };
const fee = { amount: "500", address: "0xRavnFee", chainId: 1, transaction: { to: "0xUSDC", data: "0xfeetransfer", value: "0", chainId: 1 } };
const plain = { executionType: "TRANSACTION", quoteToken: "qt-1", transaction: swapTx };
const feeBeside = { ...plain, fee };
const pending = { status: "pending", venue: "eco" };
const success = { status: "success", venue: "eco" };

// The client's check refuses these made-up addresses: it's off here (guard.test.ts covers it).
const client = (answers: Record<string, unknown[]>, config: RavnClientConfig = {}) =>
  new RavnClient({ guard: false, fetch: api(answers), ...config });
const wallet = (over: Partial<ExecuteAndTrackHandlers> = {}): ExecuteAndTrackHandlers => ({
  sendTransaction: vi.fn(async (tx: { data?: string }) => (tx.data === "0xfeetransfer" ? FEE : SWAP)),
  waitForReceipt: vi.fn(async (hash: string) => ({ status: "success", transactionHash: hash })),
  ...over,
});

let warn: ReturnType<typeof vi.spyOn>;
const warnings = () => warn.mock.calls.map((c: unknown[]) => String(c[0]));
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("development warnings: RAVN's fee not sent by executeAndTrack", () => {
  it("says so the moment the fee fails, once, and the swap still runs", async () => {
    const c = client({ execute: [feeBeside], status: [success] });
    const declined = new Error("User rejected the request");
    const r = await executeAndTrack(c, { quoteToken: "q" }, wallet({ sendTransaction: vi.fn(async (tx: { data?: string }) => { if (tx.data === "0xfeetransfer") throw declined; return SWAP; }) }), { pollIntervalMs: 0 });
    expect(r.feeError).toBe(declined);
    expect(r.finalStatus?.status).toBe("success");
    // Once: the success polled without a fee hash that follows isn't a second warning for the same swap.
    expect(warnings()).toEqual([expect.stringMatching(/^\[@ravnexchange\/sdk\] RAVN's fee on this swap wasn't sent: User rejected the request\. .*feeError.*devWarnings: false/)]);
  });

  it("an empty receipt for the swap: no fee sent, said so", async () => {
    const c = client({ execute: [feeBeside], status: [success] });
    await executeAndTrack(c, { quoteToken: "q" }, wallet({ waitForReceipt: vi.fn(async () => null) }), { pollIntervalMs: 0 });
    expect(warnings()).toEqual([expect.stringMatching(/wasn't sent: executeAndTrack: no successful receipt/)]);
  });

  it("a deposit it sent whose fee then failed, and a deposit fee it can't describe", async () => {
    const depositTx = { to: "0xDeposit", data: "0x", value: "100", chainId: 1 };
    const evm = { executionType: "DEPOSIT", quoteToken: "qt-d", statusRef: "dep-1", deposit: { address: "0xDeposit", amount: "100" }, calls: [depositTx, fee.transaction], fee };
    await executeAndTrack(client({ execute: [evm], status: [success] }), { quoteToken: "q" }, wallet({ waitForReceipt: vi.fn(async () => null) }), { sendDeposit: true, pollIntervalMs: 0 });
    const odd = { executionType: "DEPOSIT", quoteToken: "qt-x", statusRef: "dep-2", deposit: { address: "x", amount: "1" }, fee: { amount: "1", address: "x", chainId: 999 } };
    await executeAndTrack(client({ execute: [odd] }), { quoteToken: "q" }, wallet());
    expect(warnings()).toEqual([expect.stringMatching(/wasn't sent: executeAndTrack: no successful receipt/), expect.stringMatching(/wasn't sent: depositFeePayment: no known way to pay a fee on chain 999/)]);
  });

  it("quiet when the fee goes out, or the swap has none beside it", async () => {
    await executeAndTrack(client({ execute: [feeBeside], status: [success] }), { quoteToken: "q" }, wallet(), { pollIntervalMs: 0 });
    await executeAndTrack(client({ execute: [plain], status: [success] }), { quoteToken: "q" }, wallet(), { pollIntervalMs: 0 });
    expect(warnings()).toEqual([]);
  });

  it("quiet in production, unless turned on; off when turned off", async () => {
    const declining = () => wallet({ waitForReceipt: vi.fn(async () => null) });
    vi.stubEnv("NODE_ENV", "production");
    await executeAndTrack(client({ execute: [feeBeside], status: [success] }), { quoteToken: "q" }, declining(), { pollIntervalMs: 0 });
    expect(warnings()).toEqual([]);
    await executeAndTrack(client({ execute: [feeBeside], status: [success] }, { devWarnings: true }), { quoteToken: "q" }, declining(), { pollIntervalMs: 0 });
    expect(warnings()).toHaveLength(1);
    vi.stubEnv("NODE_ENV", "development");
    await executeAndTrack(client({ execute: [feeBeside], status: [success] }, { devWarnings: false }), { quoteToken: "q" }, declining(), { pollIntervalMs: 0 });
    expect(warnings()).toHaveLength(1);
  });

  it("on where NODE_ENV isn't set, or nothing defines process (a browser without a bundler)", async () => {
    vi.stubEnv("NODE_ENV", undefined);
    await executeAndTrack(client({ execute: [feeBeside], status: [success] }), { quoteToken: "q" }, wallet({ waitForReceipt: vi.fn(async () => null) }), { pollIntervalMs: 0 });
    expect(warnings()).toHaveLength(1);
    // Only the constructor reads it: put back before anything else runs.
    vi.stubGlobal("process", undefined);
    let noProcess: RavnClient;
    try {
      noProcess = client({ execute: [feeBeside], status: [success] });
    } finally {
      vi.unstubAllGlobals();
    }
    await executeAndTrack(noProcess, { quoteToken: "q" }, wallet({ waitForReceipt: vi.fn(async () => null) }), { pollIntervalMs: 0 });
    expect(warnings()).toHaveLength(2);
  });

  it("never on a sandbox swap", async () => {
    const odd = { executionType: "DEPOSIT", sandbox: true, quoteToken: "qt-x", statusRef: "dep-2", deposit: { address: "x", amount: "1" }, fee: { amount: "1", address: "x", chainId: 999 } };
    expect((await executeAndTrack(client({ execute: [odd] }), { quoteToken: "q" }, wallet())).feeError).toBeDefined();
    expect(warnings()).toEqual([]);
  });
});

describe("development warnings: a fee transaction never passed to getStatus", () => {
  it("a swap with its fee beside it that succeeds, never polled with a txHash: warned once", async () => {
    const c = client({ execute: [feeBeside], status: [pending, success, success] });
    const ex = await c.execute({ quoteToken: "q" });
    await c.getStatus(ex.quoteToken, SWAP);
    expect(warnings()).toEqual([]);
    await c.getStatus(ex.quoteToken, SWAP);
    expect(warnings()).toEqual([expect.stringMatching(/fee\.transaction.*txHash.*no fee is owed to you on this swap/)]);
    await c.getStatus(ex.quoteToken, SWAP);
    expect(warnings()).toHaveLength(1);
  });

  it("quiet once any poll passed a txHash, and on a swap that didn't succeed", async () => {
    const c = client({ execute: [feeBeside], status: [pending, success] });
    await c.getStatus((await c.execute({ quoteToken: "q" })).quoteToken, SWAP, FEE);
    await c.getStatus("qt-1", SWAP);
    const refunded = client({ execute: [feeBeside], status: [{ status: "refunded", venue: "eco" }] });
    await refunded.getStatus((await refunded.execute({ quoteToken: "q" })).quoteToken, SWAP);
    expect(warnings()).toEqual([]);
  });

  it("a DEPOSIT's fee transaction too; never a sandbox swap or a fee inside the swap's own transaction", async () => {
    const deposit = { executionType: "DEPOSIT", quoteToken: "qt-d", statusRef: "dep-1", deposit: { address: "0xDeposit", amount: "100" }, fee };
    const d = client({ execute: [deposit], status: [success] });
    await d.getStatus((await d.execute({ quoteToken: "q" })).quoteToken, "dep-1");
    expect(warnings()).toHaveLength(1);
    const sandbox = client({ execute: [{ ...feeBeside, sandbox: true }], status: [success] });
    await sandbox.getStatus((await sandbox.execute({ quoteToken: "q" })).quoteToken, "sandbox");
    const btc = { ...deposit, fee: { amount: "600", address: "bc1qravnfee", chainId: -1 } };
    const b = client({ execute: [btc], status: [success] });
    await b.getStatus((await b.execute({ quoteToken: "q" })).quoteToken, "dep-1");
    expect(warnings()).toHaveLength(1);
  });
});

describe("development warnings: a swap built and never tracked", () => {
  beforeEach(() => vi.useFakeTimers());

  it("warns 10 minutes after execute() when nothing tracked it, once per client", async () => {
    const c = client({ execute: [plain, { ...plain, quoteToken: "qt-2" }] });
    await c.execute({ quoteToken: "q" });
    await c.execute({ quoteToken: "q2" });
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS - 1);
    expect(warnings()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(warnings()).toEqual([expect.stringMatching(/built a swap 10 minutes ago and nothing has tracked it.*Ignore this if you track swaps on your server/)]);
    await c.execute({ quoteToken: "q3" });
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toHaveLength(1);
  });

  it("a status poll, submitSignature or submitTransaction is tracking; an AUTHORIZE isn't a swap built", async () => {
    const order = { executionType: "SIGNATURE", quoteToken: "qt-s", typedData: {} };
    const solana = { executionType: "TRANSACTION", quoteToken: "qt-sol", transaction: { serialized: "AQ==" }, submit: true };
    const authorize = { executionType: "AUTHORIZE", quoteToken: "qt-a", authorization: "x", sign: { method: "personal_sign", message: "m" }, expiresAt: "2099-01-01T00:00:00Z" };
    const c = client({ execute: [plain, order, solana, authorize], status: [pending], "submit-signature": [{ statusRef: "s" }], "submit-transaction": [{ txHash: "sig" }] });
    await c.getStatus((await c.execute({ quoteToken: "q" })).quoteToken, SWAP);
    await c.submitSignature({ quoteToken: (await c.execute({ quoteToken: "q" })).quoteToken, signature: "0x01" });
    await c.submitTransaction({ quoteToken: (await c.execute({ quoteToken: "q" })).quoteToken, signedTransaction: "AQ==" });
    await c.execute({ quoteToken: "q" });
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([]);
  });

  it("executeAndTrack: never for a swap it tracks, however long the wallet takes; never when nothing was sent", async () => {
    // The user leaves the fee's prompt open for 11 minutes: executeAndTrack still tracks it after.
    let confirmFee!: () => void;
    const slow = wallet({
      sendTransaction: vi.fn(async (tx: { data?: string }) => {
        if (tx.data !== "0xfeetransfer") return SWAP;
        await new Promise<void>((resolve) => (confirmFee = resolve));
        return FEE;
      }),
    });
    const tracked = executeAndTrack(client({ execute: [feeBeside], status: [success] }), { quoteToken: "q" }, slow, { pollIntervalMs: 0 });
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS + 60_000);
    confirmFee();
    // Its polls wait on (fake) timers too.
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await tracked).finalStatus?.status).toBe("success");
    // The user declines the swap itself: nothing sent, nothing to track.
    const rejected = wallet({ sendTransaction: vi.fn(async () => Promise.reject(new Error("User rejected the request"))) });
    await expect(executeAndTrack(client({ execute: [plain] }), { quoteToken: "q" }, rejected)).rejects.toThrow(/rejected/);
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([]);
  });

  it("executeAndTrack handing a swap back unfinished: the caller's to track, warned if it doesn't", async () => {
    const c = client({ execute: [plain] });
    const r = await executeAndTrack(c, { quoteToken: "q" }, wallet(), { pollUntilTerminal: false });
    expect(r.finalStatus).toBeUndefined();
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([expect.stringMatching(/nothing has tracked it/)]);
    // A deposit it didn't send, polled by the caller in time: quiet.
    const d = client({ execute: [{ executionType: "DEPOSIT", quoteToken: "qt-d", statusRef: "dep-1", deposit: { address: "bc1q", amount: "1" } }], status: [pending] });
    const unsent = await executeAndTrack(d, { quoteToken: "q" }, wallet());
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS - 1);
    await d.getStatus(unsent.quoteToken, "dep-1");
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toHaveLength(1);
  });

  it("stopped once something was out: the caller's to track from partial", async () => {
    const c = client({ execute: [plain] });
    const stop = new AbortController();
    const handlers = wallet({ sendTransaction: vi.fn(async () => (stop.abort(), SWAP)) });
    await expect(executeAndTrack(c, { quoteToken: "q" }, handlers, { signal: stop.signal })).rejects.toMatchObject({ code: "ABORTED", partial: { txHash: SWAP } });
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toHaveLength(1);
  });

  it("never keeps a Node process alive", async () => {
    vi.useRealTimers();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = real(fn, ms);
      timers.push(t);
      return t;
    }) as typeof setTimeout);
    await client({ execute: [plain] }).execute({ quoteToken: "q" });
    expect(timers).toHaveLength(1);
    expect((timers[0] as unknown as { hasRef(): boolean }).hasRef()).toBe(false);
    clearTimeout(timers[0]);
  });
});
