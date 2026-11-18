import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RavnClient } from "./client";
import type { RavnClientConfig } from "./client";
import { resetUntrackedWarning, startDevWarnings, TRACK_WITHIN_MS, warnFeeNotSent } from "./dev-warnings";
import { executeAndTrack, SentUnclearError } from "./execute-and-track";
import type { ExecuteAndTrackHandlers } from "./execute-and-track";
import type { ExecutionDTO } from "./types";

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
const noReceipt = () => wallet({ waitForReceipt: vi.fn(async () => null) });

let warn: ReturnType<typeof vi.spyOn>;
const warnings = () => warn.mock.calls.map((c: unknown[]) => String(c[0]));
beforeEach(() => {
  // vitest runs with NODE_ENV "test", where they're off: these tests are about development.
  vi.stubEnv("NODE_ENV", "development");
  resetUntrackedWarning();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("development warnings: RAVN's fee not sent by executeAndTrack", () => {
  it("says so the moment the fee fails, once, and the swap still runs", async () => {
    const c = client({ execute: [feeBeside], status: [success] });
    const declined = new Error("User rejected the request");
    const r = await executeAndTrack(c, { quoteToken: "q" }, wallet({ sendTransaction: vi.fn(async (tx: { data?: string }) => { if (tx.data === "0xfeetransfer") throw declined; return SWAP; }) }), { pollIntervalMs: 0 });
    expect(r.feeError).toBe(declined);
    expect(r.finalStatus?.status).toBe("success");
    expect(warnings()).toEqual([expect.stringMatching(/^\[@ravnexchange\/sdk\] RAVN's fee on this swap wasn't sent, or can't be proven: User rejected the request\. If the swap went through, no fee is owed.*feeError.*devWarnings: false/)]);
  });

  it("an empty receipt for the swap, or a batch id for the fee: said so", async () => {
    await executeAndTrack(client({ execute: [feeBeside], status: [success] }), { quoteToken: "q" }, noReceipt(), { pollIntervalMs: 0 });
    const batch = wallet({ sendCalls: vi.fn(async () => [SWAP, "0xbatch-id"]) });
    await executeAndTrack(client({ execute: [feeBeside], status: [success] }), { quoteToken: "q" }, batch, { pollIntervalMs: 0 });
    expect(warnings()).toEqual([expect.stringMatching(/can't be proven: executeAndTrack: no successful receipt/), expect.stringMatching(/not an on-chain transaction hash/)]);
  });

  it("quiet when the fee went out and its hash rides on the polls, even with its receipt unseen", async () => {
    const fetchImpl = api({ execute: [feeBeside], status: [success] });
    const timedOut = wallet({ waitForReceipt: vi.fn(async (hash: string) => { if (hash === FEE) throw new Error("Timed out while waiting for transaction receipt"); return { status: "success", transactionHash: hash }; }) });
    const r = await executeAndTrack(new RavnClient({ guard: false, fetch: fetchImpl }), { quoteToken: "q" }, timedOut, { pollIntervalMs: 0 });
    expect(r.feeError).toBeDefined();
    expect(r.statusTxHash).toBe(FEE);
    const polls = vi.mocked(fetchImpl).mock.calls.filter(([url]) => String(url).endsWith("/status"));
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every(([, init]) => JSON.parse(String(init?.body)).txHash === FEE)).toBe(true);
    expect(warnings()).toEqual([]);
  });

  it("a deposit it sent whose fee then failed, and a deposit fee it can't describe", async () => {
    const depositTx = { to: "0xDeposit", data: "0x", value: "100", chainId: 1 };
    const evm = { executionType: "DEPOSIT", quoteToken: "qt-d", statusRef: "dep-1", deposit: { address: "0xDeposit", amount: "100" }, calls: [depositTx, fee.transaction], fee };
    await executeAndTrack(client({ execute: [evm], status: [success] }), { quoteToken: "q" }, noReceipt(), { sendDeposit: true, pollIntervalMs: 0 });
    const odd = { executionType: "DEPOSIT", quoteToken: "qt-x", statusRef: "dep-2", deposit: { address: "x", amount: "1" }, fee: { amount: "1", address: "x", chainId: 999 } };
    await executeAndTrack(client({ execute: [odd] }), { quoteToken: "q" }, wallet());
    expect(warnings()).toEqual([expect.stringMatching(/can't be proven: executeAndTrack: no successful receipt/), expect.stringMatching(/can't be proven: depositFeePayment: no known way to pay a fee on chain 999/)]);
  });

  it("quiet when the fee goes out, or the swap has none beside it", async () => {
    await executeAndTrack(client({ execute: [feeBeside], status: [success] }), { quoteToken: "q" }, wallet(), { pollIntervalMs: 0 });
    await executeAndTrack(client({ execute: [plain], status: [success] }), { quoteToken: "q" }, wallet(), { pollIntervalMs: 0 });
    expect(warnings()).toEqual([]);
  });

  it("never on a sandbox swap", async () => {
    const odd = { executionType: "DEPOSIT", sandbox: true, quoteToken: "qt-x", statusRef: "dep-2", deposit: { address: "x", amount: "1" }, fee: { amount: "1", address: "x", chainId: 999 } };
    expect((await executeAndTrack(client({ execute: [odd] }), { quoteToken: "q" }, wallet())).feeError).toBeDefined();
    expect(warnings()).toEqual([]);
  });
});

describe("development warnings: when they're on", () => {
  const failFee = (config: RavnClientConfig = {}) =>
    executeAndTrack(client({ execute: [feeBeside], status: [success] }, config), { quoteToken: "q" }, noReceipt(), { pollIntervalMs: 0 });

  it("quiet in production and in test runs, unless turned on; off when turned off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await failFee();
    vi.stubEnv("NODE_ENV", "test");
    await failFee();
    expect(warnings()).toEqual([]);
    await failFee({ devWarnings: true });
    expect(warnings()).toHaveLength(1);
    vi.stubEnv("NODE_ENV", "development");
    await failFee({ devWarnings: false });
    expect(warnings()).toHaveLength(1);
  });

  it("on where NODE_ENV isn't set, or nothing defines process (a browser without a bundler)", async () => {
    vi.stubEnv("NODE_ENV", undefined);
    await failFee();
    expect(warnings()).toHaveLength(1);
    // Only the constructor reads it: put back before anything else runs.
    vi.stubGlobal("process", undefined);
    let noProcess: RavnClient;
    try {
      noProcess = client({ execute: [feeBeside], status: [success] });
    } finally {
      vi.unstubAllGlobals();
    }
    await executeAndTrack(noProcess, { quoteToken: "q" }, noReceipt(), { pollIntervalMs: 0 });
    expect(warnings()).toHaveLength(2);
  });

  it("never throws into a swap: an odd answer, or a console.warn that throws", async () => {
    // guard: false, an answer with no data: execute resolves to it as before, never a TypeError.
    await expect(client({ execute: [null] }).execute({ quoteToken: "q" })).resolves.toBeNull();
    vi.useFakeTimers();
    warn.mockImplementation(() => {
      throw new Error("a suite that fails on console.warn");
    });
    const r = await executeAndTrack(client({ execute: [feeBeside], status: [success] }), { quoteToken: "q" }, noReceipt(), { pollIntervalMs: 0 });
    expect(r.feeError).toBeDefined();
    expect(r.finalStatus?.status).toBe("success");
    // A timer's warning that throws doesn't surface either (vitest fails the test on an uncaught error).
    await client({ execute: [plain] }).execute({ quoteToken: "q" });
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("executeAndTrack with a JS stand-in client that answers plain values, as before", async () => {
    const standIn = { execute: () => plain, getStatus: () => success } as unknown as RavnClient;
    expect((await executeAndTrack(standIn, { quoteToken: "q" }, wallet(), { pollIntervalMs: 0 })).finalStatus).toEqual(success);
  });

  it("submitSignature and submitTransaction with no params: a promise, as before, never a throw", async () => {
    const c = client({ "submit-signature": [{ statusRef: "s" }], "submit-transaction": [{ txHash: "sig" }] });
    let calls: Promise<unknown>[] = [];
    expect(() => {
      calls = [c.submitSignature(undefined as never), c.submitTransaction(undefined as never)];
    }).not.toThrow();
    await Promise.allSettled(calls);
  });

  it("one fee warning per swap, remembering at most 1,000 swaps", () => {
    const c = {};
    startDevWarnings(c, true);
    const swap = (quoteToken: string) => ({ ...plain, quoteToken }) as unknown as ExecutionDTO;
    warnFeeNotSent(c, swap("first"), "declined");
    warnFeeNotSent(c, swap("first"), "declined");
    expect(warnings()).toHaveLength(1);
    for (let i = 0; i < 1_000; i++) warnFeeNotSent(c, swap(`other-${i}`), "declined");
    expect(warnings()).toHaveLength(1_001);
    // Forgotten as the 1,001st came in: said again.
    warnFeeNotSent(c, swap("first"), "declined");
    expect(warnings()).toHaveLength(1_002);
  });
});

describe("development warnings: a fee transaction never passed to getStatus", () => {
  beforeEach(() => vi.useFakeTimers());

  it("a swap with its fee beside it that succeeded, and no poll with a txHash in the 10 minutes after: warned once", async () => {
    const c = client({ execute: [feeBeside], status: [pending, success] });
    const ex = await c.execute({ quoteToken: "q" });
    await c.getStatus(ex.quoteToken, SWAP);
    await c.getStatus(ex.quoteToken, SWAP);
    await c.getStatus(ex.quoteToken, SWAP);
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS - 1);
    expect(warnings()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(warnings()).toEqual([expect.stringMatching(/fee\.transaction\) succeeded 10 minutes ago.*If that fee transaction wasn't sent, no fee is owed/)]);
    await c.getStatus(ex.quoteToken, SWAP);
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toHaveLength(1);
  });

  it("quiet when a poll brings the fee's hash, even after the swap succeeded, and on a swap that didn't", async () => {
    // RAVN keeps the swap open for a poll that brings the fee's hash: a useRavnStatus given txHash once the fee confirms.
    const c = client({ execute: [feeBeside], status: [success] });
    const ex = await c.execute({ quoteToken: "q" });
    await c.getStatus(ex.quoteToken, SWAP);
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS - 1);
    await c.getStatus(ex.quoteToken, SWAP, FEE);
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    const refunded = client({ execute: [feeBeside], status: [{ status: "refunded", venue: "eco" }] });
    await refunded.getStatus((await refunded.execute({ quoteToken: "q" })).quoteToken, SWAP);
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([]);
  });

  it("a DEPOSIT's fee transaction too; never a sandbox swap or a fee inside the swap's own transaction", async () => {
    const deposit = { executionType: "DEPOSIT", quoteToken: "qt-d", statusRef: "dep-1", deposit: { address: "0xDeposit", amount: "100" }, fee };
    const d = client({ execute: [deposit], status: [success] });
    await d.getStatus((await d.execute({ quoteToken: "q" })).quoteToken, "dep-1");
    const sandbox = client({ execute: [{ ...feeBeside, sandbox: true }], status: [success] });
    await sandbox.getStatus((await sandbox.execute({ quoteToken: "q" })).quoteToken, "sandbox");
    const btc = { ...deposit, quoteToken: "qt-b", fee: { amount: "600", address: "bc1qravnfee", chainId: -1 } };
    const b = client({ execute: [btc], status: [success] });
    await b.getStatus((await b.execute({ quoteToken: "q" })).quoteToken, "dep-1");
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([expect.stringMatching(/fee\.transaction/)]);
  });

  it("a swap whose polls carried the fee's hash, resumed without it after a stop: never watched again", async () => {
    const status: unknown[] = [pending];
    const c = client({ execute: [feeBeside], status });
    const stopped = expect(executeAndTrack(c, { quoteToken: "q" }, wallet(), { pollIntervalMs: 1_000, maxWaitMs: 5_000 })).rejects.toMatchObject({ code: "TIMEOUT", partial: { statusTxHash: FEE } });
    await vi.advanceTimersByTimeAsync(10_000);
    await stopped;
    // RAVN has the hash already; this poll just leaves it off.
    status.push(success);
    expect((await c.getStatus("qt-1", SWAP)).status).toBe("success");
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([]);
  });

  it("executeAndTrack's own swaps: its fee hash on every poll, or its own warning once, never two", async () => {
    // Their polls wait on (fake) timers too.
    const runs = [wallet(), noReceipt()].map((w) => executeAndTrack(client({ execute: [feeBeside], status: [success] }), { quoteToken: "q" }, w, { pollIntervalMs: 0 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await Promise.all(runs)).map((r) => r.finalStatus?.status)).toEqual(["success", "success"]);
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([expect.stringMatching(/wasn't sent, or can't be proven/)]);
  });
});

describe("development warnings: a swap built and never tracked", () => {
  beforeEach(() => vi.useFakeTimers());

  it("warns 10 minutes after execute() when nothing tracked it, once per process", async () => {
    const c = client({ execute: [plain, { ...plain, quoteToken: "qt-2" }] });
    await c.execute({ quoteToken: "q" });
    await c.execute({ quoteToken: "q2" });
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS - 1);
    expect(warnings()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(warnings()).toEqual([expect.stringMatching(/built a swap 10 minutes ago and nothing has tracked it.*Ignore this if you track swaps on your server/)]);
    // A server making a client per request: still once.
    await c.execute({ quoteToken: "q3" });
    await client({ execute: [plain] }).execute({ quoteToken: "q" });
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

  it("executeAndTrack: never for a swap it tracks, however long the wallet takes", async () => {
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
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([]);
  });

  it("executeAndTrack: never when the swap itself wasn't sent", async () => {
    const rejected = new Error("User rejected the request");
    // Declined at the swap.
    await expect(executeAndTrack(client({ execute: [plain] }), { quoteToken: "q" }, wallet({ sendTransaction: vi.fn(async () => Promise.reject(rejected)) }))).rejects.toThrow(/rejected/);
    // Approved, then declined at the swap.
    const approval = { to: "0xToken", data: "0xapprove", value: "0", chainId: 1, token: "0xToken", spender: "0xRouter", amount: "1" };
    const approvedOnly = wallet({ sendTransaction: vi.fn(async (tx: { data?: string }) => (tx.data === "0xapprove" ? `0x${"b".repeat(64)}` : Promise.reject(rejected))) });
    await expect(executeAndTrack(client({ execute: [{ ...plain, approval }] }), { quoteToken: "q" }, approvedOnly)).rejects.toMatchObject({ code: "FAILED", partial: { approvalTxHash: `0x${"b".repeat(64)}` } });
    // Stopped while execute() was still waiting on RAVN's answer.
    const stop = new AbortController();
    let answer!: () => void;
    const slowApi = vi.fn(async () => {
      await new Promise<void>((resolve) => (answer = resolve));
      return { ok: true, status: 200, json: async () => ({ data: plain }) };
    }) as unknown as typeof fetch;
    const inFlight = executeAndTrack(new RavnClient({ guard: false, fetch: slowApi }), { quoteToken: "q" }, wallet(), { signal: stop.signal });
    await vi.advanceTimersByTimeAsync(0);
    stop.abort();
    await expect(inFlight).rejects.toMatchObject({ code: "ABORTED" });
    answer();
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([]);
  });

  it("executeAndTrack handing a swap back unfinished: the caller's to track, warned if it doesn't", async () => {
    const c = client({ execute: [plain] });
    const r = await executeAndTrack(c, { quoteToken: "q" }, wallet(), { pollUntilTerminal: false });
    expect(r.finalStatus).toBeUndefined();
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([expect.stringMatching(/nothing has tracked it/)]);
  });

  it("a deposit executeAndTrack didn't send, polled by the caller in time: quiet", async () => {
    const d = client({ execute: [{ executionType: "DEPOSIT", quoteToken: "qt-d", statusRef: "dep-1", deposit: { address: "bc1q", amount: "1" } }], status: [pending] });
    const unsent = await executeAndTrack(d, { quoteToken: "q" }, wallet());
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS - 1);
    await d.getStatus(unsent.quoteToken, "dep-1");
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([]);
  });

  it("a wallet that can't say whether the swap went out: the caller's to track, as if it had", async () => {
    const unclear = wallet({ sendTransaction: vi.fn(async () => Promise.reject(new SentUnclearError("lost track of the broadcast"))) });
    await expect(executeAndTrack(client({ execute: [plain] }), { quoteToken: "q" }, unclear)).rejects.toMatchObject({ code: "FAILED", partial: { sentUnclear: true } });
    await vi.advanceTimersByTimeAsync(TRACK_WITHIN_MS);
    expect(warnings()).toEqual([expect.stringMatching(/nothing has tracked it/)]);
  });

  it("stopped once the swap was out: the caller's to track from partial", async () => {
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

  it("Deno's numeric timer ids unref'd too; one that can't be is still cleared", async () => {
    vi.useRealTimers();
    vi.spyOn(globalThis, "setTimeout").mockImplementation((() => 7) as unknown as typeof setTimeout);
    const cleared = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const unrefTimer = vi.fn();
    vi.stubGlobal("Deno", { unrefTimer });
    await client({ execute: [plain] }).execute({ quoteToken: "q" });
    expect(unrefTimer).toHaveBeenCalledWith(7);
    unrefTimer.mockImplementation(() => {
      throw new TypeError("not a timer id");
    });
    const c = client({ execute: [plain], status: [pending] });
    await c.execute({ quoteToken: "q" });
    await c.getStatus("qt-1", SWAP);
    expect(cleared).toHaveBeenCalledWith(7);
  });
});
