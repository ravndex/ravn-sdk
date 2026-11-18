/**
 * @ravnexchange/sdk/solana: ready-made executeAndTrack handlers for a Solana wallet
 * (@solana/wallet-adapter's signTransaction, or any signer of a VersionedTransaction), with the
 * checks RAVN's own app makes. Works with the app's own @solana/web3.js (1.87+ or 3.x), passed in:
 * this never loads it, so a bundle never carries a second copy, and installing the SDK never changes
 * the app's version. Plain Node ESM (no bundler) imports "@ravnexchange/sdk/dist/solana.js".
 */
import type { Connection, SignatureStatus, VersionedTransaction } from "@solana/web3.js";
import { SentUnclearError } from "./execute-and-track";
import type { ExecuteAndTrackHandlers } from "./execute-and-track";
import { base58 } from "./guard-solana";

/** The parts of a @solana/web3.js Connection these handlers use. */
export type SolanaConnection = Pick<Connection, "simulateTransaction" | "sendRawTransaction" | "getSignatureStatuses" | "isBlockhashValid">;

export interface SolanaHandlersOptions {
  /** Your RPC. Its answers decide when a transaction counts as landed or expired. */
  connection: SolanaConnection;
  /** The paying wallet: wallet-adapter's `useWallet()` (or anything with this signTransaction). */
  wallet: { signTransaction?(transaction: VersionedTransaction): Promise<VersionedTransaction> };
  /** `VersionedTransaction` from your app's own @solana/web3.js. */
  VersionedTransaction: { deserialize(serialized: Uint8Array): VersionedTransaction };
}

// web3.js's SendTransactionError: the node answered with an error (its `transactionMessage`; "failed
// to send transaction: …" before 1.9x), so it didn't pass the transaction on. Except "already been
// processed": the node has it already (a wallet or an RPC sent it first).
function nodeRefused(e: unknown): boolean {
  const x = (e ?? {}) as { transactionMessage?: unknown; message?: unknown };
  const answer = typeof x.transactionMessage === "string" ? x.transactionMessage : /^failed to send transaction: /i.test(String(x.message)) ? String(x.message) : undefined;
  return answer !== undefined && !/already been processed/i.test(answer);
}

const fromBase64 = (b64: string): Uint8Array =>
  typeof atob === "function"
    ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    : new Uint8Array((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(b64, "base64"));

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Simulates `tx` (unsigned is fine) before the wallet sees it, so a transaction that would fail never
 * reaches it (Phantom shows its "could be malicious" warning for one it can't predict). Fails open on
 * the RPC call itself (a network blip, a node lagging); refuses only when the simulation says this
 * transaction fails. A blockhash the node hasn't seen yet gets one more look after 1.5 s.
 */
export async function simulateOrThrow(connection: Pick<Connection, "simulateTransaction">, tx: VersionedTransaction): Promise<void> {
  let result: Awaited<ReturnType<Connection["simulateTransaction"]>>;
  try {
    result = await connection.simulateTransaction(tx, { sigVerify: false });
    if (result.value.err === "BlockhashNotFound") {
      await new Promise((r) => setTimeout(r, 1_500));
      result = await connection.simulateTransaction(tx, { sigVerify: false });
    }
  } catch {
    return;
  }
  if (!result.value.err) return;
  // Short of SOL for the fee or a temporary account: a fresh quote won't help, a smaller amount will.
  if (result.value.logs?.some((l) => /insufficient lamports/i.test(l))) {
    throw new Error("Insufficient funds: this wallet needs a little more SOL left over for the network fee, so nothing was sent. Try a slightly smaller amount.");
  }
  throw new Error("Simulation shows this transaction would fail on-chain (the quote may have expired), so nothing was sent. Refresh the quote and try again.");
}

/**
 * Waits for a broadcast Solana transaction to land at `confirmed`, sending the very same bytes again
 * every `pollMs` (without preflight or the node's own retries) until it lands, fails, or provably
 * can't any more. Expired, nothing moved, only on proof from the finalized chain: a node showed its
 * blockhash valid, a node further along says it no longer is, and two history lookups from at least
 * that far along don't know the signature. A failure counts only once confirmed (one seen on a fork
 * can still succeed). Past `capMs` without an answer: SentUnclearError (it may still land).
 */
export async function confirmSolanaBroadcast(
  connection: Pick<Connection, "sendRawTransaction" | "getSignatureStatuses" | "isBlockhashValid">,
  signature: string,
  signed: VersionedTransaction,
  { pollMs = 2_000, capMs = 120_000 } = {}
): Promise<void> {
  const raw = signed.serialize();
  const blockhash = signed.message.recentBlockhash;
  const answer = <T>(call: () => Promise<T>) => call().catch(() => null);
  const landed = (status: SignatureStatus | null | undefined) => {
    const final = status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";
    if (final && status?.err) throw new Error(`The transaction failed on-chain, so the swap's funds didn't move. Refresh the quote and try again. (Signature ${signature})`);
    return final;
  };
  let validAt: number | null = null;
  let expired = false;
  let unknownAfterExpiry = 0;
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    const now = await answer(() => connection.getSignatureStatuses([signature]));
    if (landed(now?.value[0])) return;
    // Past its blockhash it can't land any more: nothing to re-send.
    if (!expired) await answer(() => connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }));
    const valid = await answer(() => connection.isBlockhashValid(blockhash, { commitment: "finalized" }));
    if (valid?.value) validAt = Math.max(validAt ?? 0, valid.context.slot);
    else if (valid && validAt !== null && valid.context.slot > validAt) {
      expired = true;
      const final = await answer(() => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }));
      if (landed(final?.value[0])) return;
      unknownAfterExpiry = final && !final.value[0] && final.context.slot >= valid.context.slot ? unknownAfterExpiry + 1 : 0;
      if (unknownAfterExpiry >= 2) {
        throw new Error(`This transaction expired before the network included it, so nothing left the wallet. Refresh the quote and try again. (Signature ${signature})`);
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new SentUnclearError(
    `Lost track of this transaction after it was sent: it may still confirm. Check signature ${signature} on a Solana explorer before trying again, so it isn't sent twice.`,
    signature
  );
}

/**
 * executeAndTrack's Solana handlers: each transaction simulated before the wallet sees it; a swap
 * RAVN submits (`submit`) only signed; one sent from here broadcast, then sent again every 2 s until
 * it lands at `confirmed` (up to 2 minutes), resolving to its signature. One that failed on-chain or
 * provably expired rejects (nothing moved); one it lost track of rejects with SentUnclearError
 * carrying the signature, which executeAndTrack keeps.
 */
export function solanaHandlers({ connection, wallet, VersionedTransaction }: SolanaHandlersOptions): Pick<ExecuteAndTrackHandlers, "signSolanaTransaction" | "sendSolanaTransaction"> {
  const sign = async (serialized: string) => {
    if (!wallet.signTransaction) throw new Error("This Solana wallet can't sign transactions, so nothing was sent");
    const tx = VersionedTransaction.deserialize(fromBase64(serialized));
    await simulateOrThrow(connection, tx);
    return wallet.signTransaction(tx);
  };
  return {
    async signSolanaTransaction(serialized) {
      return toBase64((await sign(serialized)).serialize());
    },
    async sendSolanaTransaction(serialized) {
      const signed = await sign(serialized);
      const signature = base58(signed.signatures[0]);
      try {
        await connection.sendRawTransaction(signed.serialize());
      } catch (e) {
        // Refused by the node: it wasn't passed on. Anything else (no answer, "already processed") may
        // have reached the chain: the re-sends below find out.
        if (nodeRefused(e)) throw e;
      }
      await confirmSolanaBroadcast(connection, signature, signed);
      return signature;
    },
  };
}
