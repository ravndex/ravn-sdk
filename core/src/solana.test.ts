import { describe, expect, it, vi } from "vitest";
import { Keypair, SendTransactionError, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { confirmSolanaBroadcast, simulateOrThrow, solanaHandlers } from "./solana";
import { SentUnclearError } from "./execute-and-track";
import { base58 } from "./guard-solana";

// Ported from RAVN's app (useSwap.confirmSolana.test.ts, useSwap.simulateOrThrow.test.ts): the same
// cases, the same answers. A 10 USDC payment dropped by the network on 2026-10-18 showed "may still
// confirm" for a transaction that never could.

const SIG = "sig1";
const BYTES = new Uint8Array([1, 2, 3]);
const signed = { serialize: () => BYTES, message: { recentBlockhash: "BH" } } as never;
const fast = { pollMs: 0, capMs: 40 };
const roomy = { pollMs: 0, capMs: 5_000 };

type Status = { err?: unknown; confirmationStatus?: string } | null;

/** Scripted RPC: each call takes the next answer of its kind (the last one repeats). */
function rpc(script: {
  status?: Array<Status | Error>;
  history?: Array<{ slot: number; status: Status } | Error>;
  valid?: Array<{ slot: number; value: boolean } | Error>;
}) {
  const take = <T>(list: T[] | undefined, i: number) => (list && list.length ? list[Math.min(i, list.length - 1)] : undefined);
  let s = 0;
  let h = 0;
  let v = 0;
  const sends: Array<{ raw: Uint8Array; opts: unknown }> = [];
  const connection = {
    getSignatureStatuses: vi.fn(async (_sigs: string[], opts?: { searchTransactionHistory?: boolean }) => {
      if (opts?.searchTransactionHistory) {
        const a = take(script.history, h++);
        if (a instanceof Error) throw a;
        return { context: { slot: a?.slot ?? 0 }, value: [a?.status ?? null] };
      }
      const a = take(script.status, s++);
      if (a instanceof Error) throw a;
      return { context: { slot: 0 }, value: [a ?? null] };
    }),
    sendRawTransaction: vi.fn(async (raw: Uint8Array, opts?: unknown) => {
      sends.push({ raw, opts });
      return SIG;
    }),
    isBlockhashValid: vi.fn<(hash: string, opts: unknown) => Promise<{ context: { slot: number }; value: boolean }>>(async () => {
      const a = take(script.valid, v++);
      if (a instanceof Error) throw a;
      return { context: { slot: a?.slot ?? 0 }, value: a?.value ?? true };
    }),
  };
  return { connection: connection as never, sends, raw: connection };
}

/** Valid on the finalized chain at slot 100, then past it from slot 260 on. */
const expiring = [{ slot: 100, value: true }, { slot: 260, value: false }];

describe("confirmSolanaBroadcast", () => {
  it("re-sends the very same bytes, without preflight or the node's own retries, until it lands", async () => {
    const { connection, sends, raw } = rpc({ status: [null, null, { confirmationStatus: "confirmed" }], valid: [{ slot: 100, value: true }] });
    await expect(confirmSolanaBroadcast(connection, SIG, signed, roomy)).resolves.toBeUndefined();
    expect(sends.length).toBe(2);
    expect(sends.every((x) => x.raw === BYTES && JSON.stringify(x.opts) === JSON.stringify({ skipPreflight: true, maxRetries: 0 }))).toBe(true);
    // Expiry is judged on the finalized chain only.
    expect(raw.isBlockhashValid.mock.calls.every((c) => JSON.stringify(c) === JSON.stringify(["BH", { commitment: "finalized" }]))).toBe(true);
  });

  it("reports a failure once it's confirmed, never one seen only at processed (a fork)", async () => {
    const confirmed = rpc({ status: [{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }] });
    await expect(confirmSolanaBroadcast(confirmed.connection, SIG, signed, fast)).rejects.toThrow(/failed on-chain/);

    const forked = rpc({ status: [{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" }, { confirmationStatus: "confirmed" }] });
    await expect(confirmSolanaBroadcast(forked.connection, SIG, signed, roomy)).resolves.toBeUndefined();
  });

  it("says nothing moved after two lookups past expiry don't know the signature, and stops re-sending once expired", async () => {
    const { connection, sends } = rpc({ valid: expiring, history: [{ slot: 261, status: null }] });
    const error = await confirmSolanaBroadcast(connection, SIG, signed, roomy).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/expired before the network included it, so nothing left the wallet/);
    expect(error).not.toBeInstanceOf(SentUnclearError);
    // One re-send while valid, one on the poll that first saw it expired: none after.
    expect(sends.length).toBe(2);
  });

  it("finds a transaction that landed just before its blockhash expired", async () => {
    const { connection } = rpc({ valid: expiring, history: [{ slot: 261, status: null }, { slot: 263, status: { confirmationStatus: "finalized" } }] });
    await expect(confirmSolanaBroadcast(connection, SIG, signed, roomy)).resolves.toBeUndefined();
  });

  it("never calls it expired while the history still shows it (processed, not confirmed yet)", async () => {
    const { connection } = rpc({ valid: expiring, history: [{ slot: 261, status: { confirmationStatus: "processed" } }] });
    await expect(confirmSolanaBroadcast(connection, SIG, signed, fast)).rejects.toThrow(/may still confirm/);
  });

  it("never calls it expired on a blockhash no node has shown valid (a node behind it), nor from a node behind the last valid answer", async () => {
    const unseen = rpc({ valid: [{ slot: 300, value: false }], history: [{ slot: 301, status: null }] });
    await expect(confirmSolanaBroadcast(unseen.connection, SIG, signed, fast)).rejects.toThrow(/may still confirm/);
    expect(unseen.raw.getSignatureStatuses.mock.calls.some((c) => c[1])).toBe(false);

    const lagging = rpc({ valid: [{ slot: 200, value: true }, { slot: 150, value: false }], history: [{ slot: 301, status: null }] });
    await expect(confirmSolanaBroadcast(lagging.connection, SIG, signed, fast)).rejects.toThrow(/may still confirm/);
  });

  it("never calls it expired on a history lookup from a node behind the expiry", async () => {
    const { connection } = rpc({ valid: expiring, history: [{ slot: 250, status: null }] });
    await expect(confirmSolanaBroadcast(connection, SIG, signed, fast)).rejects.toThrow(/may still confirm/);
  });

  it("keeps the cautious answer, with the signature, when the RPC won't answer", async () => {
    const down = new Error("fetch failed");
    const { connection } = rpc({ status: [down], valid: [down], history: [down] });
    const error = await confirmSolanaBroadcast(connection, SIG, signed, fast).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/Lost track of this transaction/);
    expect(error).toBeInstanceOf(SentUnclearError);
    expect((error as SentUnclearError).txHash).toBe(SIG);
  });
});

function fakeTx(size = 200) {
  return { serialize: () => new Uint8Array(size) } as never;
}
const simulating = (simulateTransaction: (...args: unknown[]) => unknown) => ({ simulateTransaction }) as never;

describe("simulateOrThrow", () => {
  it("resolves when simulation reports no error", async () => {
    await expect(simulateOrThrow(simulating(async () => ({ value: { err: null, logs: [], unitsConsumed: 1000 } })), fakeTx())).resolves.toBeUndefined();
  });

  it("refuses with a refresh-the-quote error when simulation reports a failure", async () => {
    const connection = simulating(async () => ({ value: { err: { InstructionError: [0, "Custom"] }, logs: ["failed"] } }));
    await expect(simulateOrThrow(connection, fakeTx())).rejects.toThrow(/expired/i);
  });

  // Live 2026-10-01: Max SOL sold through OKX ran out of lamports for its temporary wSOL account.
  it("names a SOL shortfall as a balance problem, not an expired quote", async () => {
    const connection = simulating(async () => ({
      value: {
        err: { InstructionError: [2, { Custom: 1 }] },
        logs: ["Program 11111111111111111111111111111111 invoke [1]", "Transfer: insufficient lamports 339146544, need 340809150"],
      },
    }));
    await expect(simulateOrThrow(connection, fakeTx())).rejects.toThrow(/^Insufficient funds: .*more SOL/);
  });

  it("asks again when the node hasn't seen the blockhash yet, and refuses one that stays unknown", async () => {
    vi.useFakeTimers();
    try {
      const lagging = [{ err: "BlockhashNotFound", logs: [] }, { err: null, logs: [] }];
      const caughtUp = simulateOrThrow(simulating(async () => ({ value: lagging.shift() })), fakeTx());
      await vi.advanceTimersByTimeAsync(1500);
      await expect(caughtUp).resolves.toBeUndefined();

      const expired = simulateOrThrow(simulating(async () => ({ value: { err: "BlockhashNotFound", logs: [] } })), fakeTx()).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await expired).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open (does not throw) when the RPC call itself errors", async () => {
    await expect(simulateOrThrow(simulating(async () => Promise.reject(new Error("network down"))), fakeTx())).resolves.toBeUndefined();
  });
});

describe("solanaHandlers", () => {
  const payer = Keypair.generate();
  const unsigned = () => {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  };
  const wallet = {
    signTransaction: vi.fn(async (tx: VersionedTransaction) => {
      tx.sign([payer]);
      return tx;
    }),
  };
  const ok = async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } });

  it("signs after a clean simulation and hands the signed transaction back, sending nothing", async () => {
    const connection = { simulateTransaction: vi.fn(ok), sendRawTransaction: vi.fn() };
    const out = await solanaHandlers({ connection: connection as never, wallet }).signSolanaTransaction!(unsigned());
    const tx = VersionedTransaction.deserialize(Buffer.from(out, "base64"));
    expect(tx.signatures[0].some((b) => b !== 0)).toBe(true);
    expect(connection.simulateTransaction).toHaveBeenCalledOnce();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("never opens the wallet for a transaction the simulation says fails", async () => {
    wallet.signTransaction.mockClear();
    const connection = { simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: { InstructionError: [0, "Custom"] }, logs: [] } }) };
    await expect(solanaHandlers({ connection: connection as never, wallet }).sendSolanaTransaction!(unsigned())).rejects.toThrow(/nothing was sent/);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("sends, waits for it to land at confirmed, and returns its signature", async () => {
    const { raw } = rpc({ status: [null, { confirmationStatus: "confirmed" }] });
    const connection = { ...raw, simulateTransaction: vi.fn(ok) };
    const sig = await solanaHandlers({ connection: connection as never, wallet }).sendSolanaTransaction!(unsigned());
    const sent = VersionedTransaction.deserialize(raw.sendRawTransaction.mock.calls[0][0]);
    expect(sig).toBe(base58(sent.signatures[0]));
    // The first send with the node's preflight, then the same bytes re-sent without it.
    expect(raw.sendRawTransaction.mock.calls[0][1]).toBeUndefined();
    expect(raw.sendRawTransaction.mock.calls[1]).toEqual([raw.sendRawTransaction.mock.calls[0][0], { skipPreflight: true, maxRetries: 0 }]);
  });

  it("a node refusing the first send: nothing sent; no answer at all: re-sent until it lands", async () => {
    const refused = { simulateTransaction: ok, sendRawTransaction: vi.fn(async () => Promise.reject(new SendTransactionError({ action: "send", signature: "", transactionMessage: "Blockhash not found" }))) };
    await expect(solanaHandlers({ connection: refused as never, wallet }).sendSolanaTransaction!(unsigned())).rejects.toBeInstanceOf(SendTransactionError);
    expect(refused.sendRawTransaction).toHaveBeenCalledOnce();

    const { raw } = rpc({ status: [null, { confirmationStatus: "confirmed" }] });
    raw.sendRawTransaction.mockImplementationOnce(async () => Promise.reject(new Error("fetch failed")));
    const silent = { ...raw, simulateTransaction: ok };
    await expect(solanaHandlers({ connection: silent as never, wallet }).sendSolanaTransaction!(unsigned())).resolves.toEqual(expect.any(String));
  });
});
