import type { RavnClient } from "./client";
import { RavnApiError } from "./types";
import type { ApprovalDTO, DepositFeeDTO, ExecuteParams, ExecutionDTO, StatusDTO } from "./types";
import { isPollingTerminal } from "./polling";

type TxLike = { to?: string; data?: string; value?: string; chainId?: number; serialized?: string };

/**
 * The parts of a transaction receipt executeAndTrack reads. viem's and wagmi's
 * `waitForTransactionReceipt`, ethers v5 and v6 (`tx.wait()`, `provider.waitForTransaction`) and
 * web3.js receipts all fit as they are.
 */
export type TransactionReceiptLike =
  | { status?: unknown; transactionHash: string }
  | { status?: unknown; hash: string };

export interface ExecuteAndTrackHandlers {
  /** Broadcast a transaction (an approval, the main swap tx, or RAVN's fee) and return its hash. */
  sendTransaction(tx: TxLike): Promise<string>;
  /**
   * Wait for a transaction hash to confirm and resolve to its receipt. Called on the approval
   * before the main tx is ever sent: sending both back-to-back races the allowance and is the most
   * common integration bug this helper exists to prevent. Also called on the swap before RAVN's fee
   * is sent on its own (`fee.transaction`): the fee is only sent when the receipt says success AND
   * is this hash's own (a cancelled or replaced swap resolves with another transaction's). A
   * handler resolving to nothing doesn't compile: it would never get the fee sent. `null` (ethers
   * with 0 confirmations) sends no fee: a fee on a swap that didn't run is the user's money lost.
   */
  waitForReceipt(hash: string, chainId?: number): Promise<TransactionReceiptLike | null>;
  /**
   * Optional: send several calls in ONE wallet confirmation that succeeds or fails as a whole
   * (EIP-5792 `wallet_sendCalls` with `atomicRequired: true`, a smart account) and resolve, once
   * they have landed, to the on-chain hash of the transaction that carried each call, in order
   * (the same hash repeated, or just one, for one transaction). Not a batch id or a 4337
   * userOpHash: RAVN proves its fee from that transaction. When given, a token-paid RAVN fee rides
   * in the swap's own confirmation, and so does the swap's approval when it needs one; a
   * native-coin fee is always a plain transaction of its own. The batch's gas limit is your
   * wallet's (EIP-5792 carries none): give it headroom, as a wallet estimating it tight reverts
   * the whole batch. Reject only when nothing was sent: a rejection loses the swap's hash.
   */
  sendCalls?(txs: TxLike[]): Promise<string[]>;
  /** Sign an EIP-712 typed-data payload. Only called for SIGNATURE executions. */
  signTypedData?(typedData: Record<string, unknown>): Promise<`0x${string}`>;
  /**
   * Sign (don't send) a base64 Solana transaction and return it signed, base64. Only called for a
   * TRANSACTION carrying `submit` (broadcastViaRavn quotes), which RAVN checks and sends itself.
   */
  signSolanaTransaction?(serialized: string): Promise<string>;
  /**
   * The API sends `approval` whenever the venue generically needs an allowance: it deliberately
   * never reads the chain to check whether the caller already has one (that's an RPC round-trip
   * on every execute). Without this handler, that approval tx is sent unconditionally, even when
   * unnecessary: the caller pays gas for a redundant approve on every swap of the same
   * token/spender. Supply this (an allowance read against your own RPC) to skip it when already
   * sufficient, same as the first-party app's own ensureErc20Allowance does.
   */
  hasAllowance?(approval: ApprovalDTO): Promise<boolean>;
}

/** What just happened: a transaction's hash is known (sent, not yet confirmed), a swap was signed
 * for RAVN to submit (`signedTransaction` for a Solana swap, `signature` for an order), or a status
 * poll answered. */
export type ExecuteAndTrackStage = "reset_sent" | "approval_sent" | "swap_signed" | "swap_sent" | "fee_sent" | "status";

export interface ExecuteAndTrackProgress {
  stage: ExecuteAndTrackStage;
  /** Everything known so far. Persist it: it's all you need to keep tracking the swap if this
   * call never returns (a closed tab, a crash). "swap_sent" carries `statusRef`. */
  partial: ExecuteAndTrackPartial;
}

export interface ExecuteAndTrackOptions {
  /** Default true. Set false to get a ref back once the swap (and RAVN's fee, when one is sent) is
   * out, and poll getStatus yourself with `statusTxHash`. */
  pollUntilTerminal?: boolean;
  /** Default 4000. Also where the backoff after a failed call starts (doubling, up to a minute). */
  pollIntervalMs?: number;
  /** How often to poll a swap that's `expired`: a refund is due and can take hours (Across returns
   * it in a later settlement bundle). Default 60000. */
  expiredPollIntervalMs?: number;
  /** Stop polling this long after the first status poll, rejecting with an ExecuteAndTrackError
   * ("TIMEOUT") that carries every hash: keep polling getStatus with them yourself. Default: no
   * limit (a swap may sit `expired` for hours). */
  maxWaitMs?: number;
  /** Stop: nothing more goes to the wallet and polling ends, rejecting with an
   * ExecuteAndTrackError ("ABORTED"). A wallet prompt already open isn't withdrawn; whatever it
   * sends is in the error's `partial`. A submitSignature or submitTransaction call already under
   * way is awaited first: its answer is the swap's only handle. */
  signal?: AbortSignal;
  /** Called with every hash the moment it exists (approval, swap with its statusRef, fee) and with
   * every status poll. An error it throws is ignored: it never stops a swap that's out. */
  onProgress?(progress: ExecuteAndTrackProgress): void;
}

export interface ExecuteAndTrackResult {
  execution: ExecutionDTO;
  /** The `approval.reset` (approve to 0) sent before the approval, when the token needed one. */
  resetTxHash?: string;
  approvalTxHash?: string;
  txHash?: string;
  /** Pass to client.getStatus(quoteToken, statusRef). Same as `execution.quoteToken`, NOT the
   * quote's own token: on compose (2-hop) quotes execute rebinds hop 1 onto hop 2's deposit. */
  quoteToken: string;
  /** Pass to client.getStatus(quoteToken, statusRef). For TRANSACTION, the execution's own
   * statusRef when it has one (compose, Garden, Relay), else txHash: not always a tx hash. */
  statusRef?: string;
  /** Pass as getStatus's third argument (`txHash`) on every poll you make yourself, from the first
   * one until a terminal status and once more after a success (RAVN's node may be a block behind
   * yours): the fee payment's transaction when one was sent (already confirmed by the time this
   * returns), else, with a statusRef, the swap's own tx (a two-hop route's hop 1 proves its fee;
   * ignored elsewhere). It's how RAVN proves the fee your share is paid from: the venue's own
   * tracker saying "delivered" doesn't book it. */
  statusTxHash?: string;
  /** The transaction that carried RAVN's fee (`execution.fee.transaction`), once sent. Sent isn't
   * paid (a batch can revert): RAVN's status polls are what prove it. */
  feeTxHash?: string;
  /** Why RAVN's fee wasn't sent (or its receipt not seen): the swap still runs and is tracked, but
   * no fee is owed to you on it unless `feeTxHash` is set and it landed. */
  feeError?: unknown;
  /** DEPOSIT only: the fee payment to make beside the deposit (see depositFeePayment). */
  feePayment?: DepositFeePayment;
  /** Set once pollUntilTerminal reaches a terminal status. Absent for DEPOSIT (see below) or when polling is turned off. */
  finalStatus?: StatusDTO;
}

/** What executeAndTrack knew when it reported progress or stopped: every hash sent so far, and the
 * last status it saw. `signedTransaction` (broadcastViaRavn): the signed Solana swap handed to
 * submitTransaction; post it again with the same quoteToken (RAVN never sends it twice) to learn
 * whether it landed, before signing anything new. `signature` (SIGNATURE): the signed order handed
 * to submitSignature; "swap_signed" with no "swap_sent" after it means the call failed or got no
 * answer, and the venue may still have taken the order: check before signing a new one. */
export type ExecuteAndTrackPartial = Partial<ExecuteAndTrackResult> & {
  lastStatus?: StatusDTO;
  signedTransaction?: string;
  signature?: `0x${string}`;
};

/**
 * How executeAndTrack rejects once anything has been sent or signed (an approval, the swap, a
 * signature handed to RAVN), and on any abort or timeout: `partial` carries every hash, so the
 * swap is never lost. Keep polling getStatus(partial.quoteToken, partial.statusRef,
 * partial.statusTxHash). Before anything is sent, errors come as they are (a RavnApiError from
 * execute, the wallet's own rejection).
 */
export class ExecuteAndTrackError extends Error {
  /** What failed underneath: a RavnApiError, the wallet's error, or your signal's reason. */
  declare readonly cause?: unknown;

  constructor(
    message: string,
    /** "ABORTED": your signal. "TIMEOUT": maxWaitMs passed. "FAILED": anything else; see `cause`. */
    public readonly code: "ABORTED" | "TIMEOUT" | "FAILED",
    public readonly partial: ExecuteAndTrackPartial,
    cause?: unknown
  ) {
    super(message);
    this.name = "ExecuteAndTrackError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** How to pay a DEPOSIT's `fee`, so it's proven against this swap. See DepositFeeDTO. Either way,
 * poll RAVN's getStatus until a terminal status even when the venue's own tracker (e.g. Rift's API)
 * already says delivered: RAVN books the fee on its own status polls. */
export type DepositFeePayment =
  /** EVM: send `transaction` exactly as given once the deposit has confirmed, then pass its
   * on-chain hash as `txHash` on every getStatus poll; at least one must come after it confirmed,
   * or nothing is owed. A token fee (`value` "0") may instead ride in the deposit's own atomic
   * wallet batch: pass the hash of the transaction that carried it (not a batch id or userOpHash).
   * A native-coin fee: a plain transaction of its own. */
  | { kind: "transaction"; transaction: NonNullable<DepositFeeDTO["transaction"]> }
  /** Bitcoin: an extra output paying `amount` sats to `address` in the SAME transaction that pays
   * the deposit. One deposit per transaction: a fee output proves one swap. */
  | { kind: "bitcoin_output"; address: string; amount: string }
  /** Solana: a transfer of `amount` to `address` in the SAME transaction that pays the deposit
   * exactly `deposit.amount` (SOL as lamports, not wrapped). SOL: a System transfer of `amount`
   * lamports to `address`. A token: `createAssociatedTokenAccountIdempotent` for `address`'s
   * associated token account for the input mint (under the mint's token program), then
   * `transferChecked` of `amount` to it. Sent in a transaction of its own, it isn't found. */
  | { kind: "solana_transfer"; address: string; amount: string };

const BITCOIN_CHAIN_ID = -1;
const SOLANA_CHAIN_ID = -2;
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;
// What a sandbox status poll is sent as ref when there's no tx hash: RAVN doesn't read it.
const SANDBOX_REF = "sandbox";
const EXPIRED_POLL_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
// ponytail: a fixed cap, ~4 min of backoff at the default interval; past it the call rejects with
// every hash to resume from. Make it an option if integrators need to ride out longer outages.
const MAX_ATTEMPTS = 8;
// An execute asked again with its Idempotency-Key: ~30 s at the default interval, so a call that
// can't get through fails in about that rather than four minutes.
const EXECUTE_ATTEMPTS = 4;

/** The fee payment a DEPOSIT execution asks for beside its deposit; undefined when it has none. */
export function depositFeePayment(execution: ExecutionDTO): DepositFeePayment | undefined {
  if (execution.executionType !== "DEPOSIT" || !execution.fee) return undefined;
  const { transaction, address, amount, chainId } = execution.fee;
  if (transaction) return { kind: "transaction", transaction };
  if (chainId === BITCOIN_CHAIN_ID) return { kind: "bitcoin_output", address, amount };
  if (chainId === SOLANA_CHAIN_ID) return { kind: "solana_transfer", address, amount };
  throw new Error(`depositFeePayment: no known way to pay a fee on chain ${chainId}`);
}

// Only a receipt that says success (viem "success", ethers 1; web3.js 1n/true, so == on purpose) and
// is `hash`'s own (viem/ethers v5 transactionHash, ethers v6 hash): viem resolves a cancelled swap
// with the replacement's successful receipt. Typed unknown: JS callers can still hand it anything.
const receiptSucceeded = (receipt: unknown, hash: string): boolean => {
  const r = receipt as { status?: unknown; transactionHash?: unknown; hash?: unknown } | null | undefined;
  const own = r?.transactionHash ?? r?.hash;
  return (r?.status === "success" || r?.status == 1) && (typeof own !== "string" || own.toLowerCase() === hash.toLowerCase());
};

// The same call can succeed later: no response at all, a 429, or a 5xx.
const transient = (err: unknown): boolean =>
  err instanceof RavnApiError && (err.code === "NETWORK_ERROR" || err.status === 429 || (err.status ?? 0) >= 500);
// Refused before anything was done, so safe to repeat even a call that isn't safe to repeat after
// a BUILD_FAILED (submit-signature: the venue may have taken the order).
const rateLimited = (err: unknown): boolean =>
  err instanceof RavnApiError && (err.code === "RATE_LIMITED" || err.code === "VENUE_RATE_LIMITED" || err.status === 429);

// An execute sent with an Idempotency-Key answers a repeat with its first answer, so one whose answer
// was lost (no response, a gateway timeout) or is still being built (UNAVAILABLE) can be asked again.
// Never a BUILD_FAILED (re-quote) or an unexpected error, which may have half-built an order.
const answerLost = (err: unknown): boolean =>
  rateLimited(err) ||
  (err instanceof RavnApiError && (err.code === "NETWORK_ERROR" || err.code === "UNAVAILABLE" || err.status === 504));

// `promise`, or the signal's reason as soon as it aborts: a wallet or custom fetch may ignore the
// signal. `promise` is always handled, so one that rejects after the abort is never unhandled.
const orAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    // Promise.resolve: a JS handler may hand back the value itself rather than a promise.
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Sequences execute() → approval (if any) → wait for its receipt → main tx/signature → RAVN's fee
 * payment (if any) → status polling, using caller-supplied signing/sending functions. The SDK
 * stays wallet-agnostic (no RPC dependency); this just gets the ORDER right, which quickstart's
 * own docs flag as the most common integration failure: sending the main tx before the approval
 * has confirmed. A failed API call is retried where repeating it is safe (status polls and
 * submitTransaction on a 429, 5xx or no response; execute, sent with an Idempotency-Key, also when its
 * answer was lost or is still being built, up to 4 tries; submitSignature only when rate limited),
 * waiting the API's retryAfterSec. Once anything
 * is sent, it rejects only with an ExecuteAndTrackError carrying every hash; `onProgress` hears
 * each one first.
 */
export async function executeAndTrack(
  client: RavnClient,
  params: ExecuteParams,
  handlers: ExecuteAndTrackHandlers,
  options: ExecuteAndTrackOptions = {}
): Promise<ExecuteAndTrackResult> {
  const { pollUntilTerminal = true, pollIntervalMs = 4_000, expiredPollIntervalMs = EXPIRED_POLL_INTERVAL_MS, maxWaitMs } = options;
  const partial: ExecuteAndTrackPartial = {};
  let sent = false;
  const report = (stage: ExecuteAndTrackStage, fields: ExecuteAndTrackPartial) => {
    Object.assign(partial, fields);
    try {
      // An async hook (a database write) may reject: handled here too, never unhandled.
      Promise.resolve(options.onProgress?.({ stage, partial: { ...partial } })).catch(() => {});
    } catch {
      // The swap is out either way: a failing progress hook must not stop its fee or tracking.
    }
  };

  // One signal for everything that waits: the caller's abort, or maxWaitMs once polling starts.
  const stop = new AbortController();
  let stopCode: "ABORTED" | "TIMEOUT" | undefined;
  const halt = (code: "ABORTED" | "TIMEOUT", reason: unknown) => {
    if (stop.signal.aborted) return;
    stopCode = code;
    stop.abort(reason);
  };
  const onAbort = () => halt("ABORTED", options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  // Before each step that asks the wallet for something: never send once stopped.
  const checkpoint = () => {
    if (stop.signal.aborted) throw stop.signal.reason;
  };

  // Calls `call` until it succeeds, fails in a way `retryable` says repeating can't fix, or
  // `attempts`: waiting the API's retryAfterSec, else an interval doubling from pollIntervalMs.
  const withRetries = async <T>(call: () => Promise<T>, retryable: (err: unknown) => boolean, attempts = MAX_ATTEMPTS): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        if (attempt >= attempts || !retryable(err)) throw err;
        const askedMs = ((err as RavnApiError).retryAfterSec ?? 0) * 1_000;
        await sleep(Math.max(askedMs, Math.min(pollIntervalMs * 2 ** (attempt - 1), MAX_BACKOFF_MS)), stop.signal);
      }
    }
  };

  const run = async (): Promise<ExecuteAndTrackResult> => {
    checkpoint();
    // One Idempotency-Key for every try, so a repeat can't open a second order at the venue (a NEAR
    // deposit address, a Houdini or Garden order). Without one (no crypto.randomUUID), only a rate
    // limit is repeated. A BUILD_FAILED wants a fresh quote either way.
    const key = params.idempotencyKey ?? globalThis.crypto?.randomUUID?.();
    const execution = await withRetries(
      () => orAbort(client.execute({ ...params, ...(key ? { idempotencyKey: key } : {}) }), stop.signal),
      key ? answerLost : rateLimited,
      key ? EXECUTE_ATTEMPTS : MAX_ATTEMPTS
    );
    const { quoteToken } = execution;
    Object.assign(partial, { execution, quoteToken, statusRef: execution.statusRef });

    const pollStatus = async (ref: string, txHash?: string, feeSent = false): Promise<StatusDTO | undefined> => {
      if (!pollUntilTerminal) return undefined;
      if (maxWaitMs !== undefined) {
        deadline = setTimeout(() => halt("TIMEOUT", new Error(`executeAndTrack: no terminal status within maxWaitMs (${maxWaitMs} ms)`)), maxWaitMs);
      }
      // A success answered before RAVN's node sees the fee tx proves nothing, and the row is then
      // left to a cron that books no fee: one more poll after it.
      // ponytail: one re-poll covers a block of lag; /v1/status also stays "processing" while a
      // reported fee tx is unreadable (ravn-mvp #411).
      for (let recheck = feeSent; ; ) {
        checkpoint();
        const status = await withRetries(() => orAbort(client.getStatus(quoteToken, ref, txHash, { signal: stop.signal }), stop.signal), transient);
        report("status", { lastStatus: status });
        if (isPollingTerminal(status.status)) {
          if (!recheck || status.status !== "success") return status;
          recheck = false;
        }
        await sleep(status.status === "expired" ? expiredPollIntervalMs : pollIntervalMs, stop.signal);
      }
    };

    // A sandbox execution is never real, but a venue with no sandbox stand-in returns its live
    // payload: nothing in it is signed or sent (a signed order or Solana payment is a live
    // instrument even though RAVN drops it). RAVN answers its status synthetically, for any ref.
    if (execution.sandbox && execution.executionType !== "DEPOSIT") {
      const statusRef = execution.statusRef ?? SANDBOX_REF;
      return { execution, quoteToken, statusRef, finalStatus: await pollStatus(statusRef) };
    }

    // The approval to send, if any: none when the caller already knows it's covered (see
    // ExecuteAndTrackHandlers.hasAllowance).
    const neededApproval = async (approval: ApprovalDTO | undefined): Promise<ApprovalDTO | undefined> =>
      approval && !(handlers.hasAllowance && (await orAbort(handlers.hasAllowance(approval), stop.signal))) ? approval : undefined;

    // Sends and confirms it, after its reset (approve to 0) when the token needs one first.
    const maybeSendApproval = async (approval: ApprovalDTO | undefined): Promise<string | undefined> => {
      const needed = await neededApproval(approval);
      if (!needed) return undefined;
      let hash = "";
      for (const tx of needed.reset ? [{ ...needed.reset, chainId: needed.chainId }, needed] : [needed]) {
        checkpoint();
        hash = await handlers.sendTransaction(tx);
        sent = true;
        if (tx === needed) report("approval_sent", { approvalTxHash: hash });
        else report("reset_sent", { resetTxHash: hash });
        await orAbort(handlers.waitForReceipt(hash, needed.chainId), stop.signal);
      }
      return hash;
    };

    if (execution.executionType === "TRANSACTION" && execution.submit) {
      // Never broadcast this one ourselves: a payment Layerswap can't match sits at Layerswap, and
      // RAVN's check before sending is what catches it.
      if (!handlers.signSolanaTransaction) {
        throw new Error("executeAndTrack: this execution must be submitted through RAVN and requires signSolanaTransaction, none was provided");
      }
      if (!execution.transaction.serialized) {
        throw new Error("executeAndTrack: TRANSACTION execution with submit is missing transaction.serialized");
      }
      const serialized = execution.transaction.serialized;
      checkpoint();
      const signedTransaction = await handlers.signSolanaTransaction(serialized);
      checkpoint();
      // From here RAVN may have sent it, even on a failed call. A retry with the same signed
      // transaction never sends it twice, so retrying is how to find out; a failure that names
      // the signature (BUILD_FAILED's details.txHash) is kept too.
      sent = true;
      report("swap_signed", { signedTransaction });
      const submit = async () => {
        try {
          return await client.submitTransaction({ quoteToken, signedTransaction });
        } catch (err) {
          const named = err instanceof RavnApiError ? (err.details as { txHash?: unknown } | undefined)?.txHash : undefined;
          if (typeof named === "string") Object.assign(partial, { txHash: named, statusRef: execution.statusRef ?? named });
          throw err;
        }
      };
      const { txHash } = await withRetries(submit, transient);
      const statusRef = execution.statusRef ?? txHash;
      report("swap_sent", { txHash, statusRef });
      return { execution, quoteToken, txHash, statusRef, finalStatus: await pollStatus(statusRef) };
    }

    if (execution.executionType === "TRANSACTION") {
      // RAVN's fee, when the route has none of its own (Eco, Layerswap, Mayan plain MCTP). From
      // Solana there's nothing to send: it's a transfer inside transaction.serialized.
      const { approval, transaction } = execution;
      const feeTx = execution.fee?.transaction;
      // What proves the fee, from the first poll on: its own transaction, else (a statusRef: a
      // two-hop route) hop 1's. Only an EVM tx hash: /v1/status refuses anything else (a Solana
      // signature, a batch id) on every poll.
      const proof = (swapHash: string, feeHash?: string) => {
        const hash = feeHash ?? (execution.statusRef ? swapHash : undefined);
        return hash && EVM_TX_HASH.test(hash) ? hash : undefined;
      };
      let txHash: string;
      let feeTxHash: string | undefined;
      let feeError: unknown;
      if (feeTx && BigInt(feeTx.value) === 0n && handlers.sendCalls) {
        // A token fee may ride in the swap's own confirmation, and the swap's approval with it:
        // atomic, so neither outlives a swap that reverted. Only here: ExecutionDTO doesn't name
        // its venue, and the first-party app never batches THORChain (Bifrost ignores a router
        // deposit whose tx.to is the user's own 7702 account) or Bebop (its settlement needs gas
        // headroom a batch leaves to the wallet); fee-beside routes are neither.
        const batchApproval = await neededApproval(approval);
        const reset = batchApproval?.reset && { ...batchApproval.reset, chainId: batchApproval.chainId };
        const approvals = batchApproval ? [...(reset ? [reset] : []), batchApproval] : [];
        checkpoint();
        const hashes = await handlers.sendCalls([...approvals, transaction, feeTx]);
        // The wallet resolved, so something may be out: from here an error carries what's known.
        sent = true;
        // Fewer hashes back than calls: the last one carried the rest.
        const carrier = (i: number) => hashes[Math.min(i, hashes.length - 1)];
        if (!carrier(0)) throw new Error("executeAndTrack: sendCalls returned no transaction hash");
        txHash = carrier(approvals.length);
        feeTxHash = carrier(approvals.length + 1);
        if (reset) report("reset_sent", { resetTxHash: carrier(0) });
        if (batchApproval) report("approval_sent", { approvalTxHash: carrier(approvals.length - 1) });
        report("swap_sent", { txHash, statusRef: execution.statusRef ?? txHash, statusTxHash: proof(txHash) });
        report("fee_sent", { feeTxHash, statusTxHash: proof(txHash, feeTxHash) });
      } else {
        await maybeSendApproval(approval);
        checkpoint();
        txHash = await handlers.sendTransaction(transaction);
        sent = true;
        report("swap_sent", { txHash, statusRef: execution.statusRef ?? txHash, statusTxHash: proof(txHash) });
        if (feeTx) {
          // On its own, only once the swap has confirmed: a reverted, dropped or replaced one pays
          // no fee. Declined or failed (or stopped first), the swap still runs and is tracked; no
          // fee is owed on it.
          try {
            if (!receiptSucceeded(await orAbort(handlers.waitForReceipt(txHash, transaction.chainId), stop.signal), txHash)) {
              throw new Error("executeAndTrack: no successful receipt for the swap transaction itself, so RAVN's fee was not sent");
            }
            checkpoint();
            feeTxHash = await handlers.sendTransaction(feeTx);
            report("fee_sent", { feeTxHash, statusTxHash: proof(txHash, feeTxHash) });
            // Confirmed before polling starts: a swap that fills first would otherwise end the
            // polling on the one poll that had to prove the fee.
            await orAbort(handlers.waitForReceipt(feeTxHash, feeTx.chainId), stop.signal);
          } catch (err) {
            feeError = err;
          }
        }
      }
      // Stopped before or during the fee: say so, even with polling off (no fee was sent on it).
      checkpoint();
      const statusRef = execution.statusRef ?? txHash;
      const statusTxHash = proof(txHash, feeTxHash);
      if (feeTxHash && !statusTxHash) {
        feeError ??= new Error(`executeAndTrack: ${feeTxHash} is not an on-chain transaction hash, so RAVN can't prove the fee`);
      }
      partial.feeError = feeError;
      return {
        execution, quoteToken, resetTxHash: partial.resetTxHash, approvalTxHash: partial.approvalTxHash, txHash, statusRef, statusTxHash, feeTxHash, feeError,
        finalStatus: await pollStatus(statusRef, statusTxHash, !!feeTxHash && !!statusTxHash),
      };
    }

    if (execution.executionType === "SIGNATURE") {
      if (!handlers.signTypedData) {
        throw new Error("executeAndTrack: this execution requires signTypedData, none was provided");
      }
      if (!execution.typedData) {
        throw new Error("executeAndTrack: SIGNATURE execution is missing typedData");
      }
      // A signed order isn't allowance-free: CoW's vault relayer and Bebop/0x's Permit2 still pull
      // the sell token with transferFrom, so this on-chain allowance (separate from approvalData's
      // gasless per-trade signature) must be confirmed before signing, otherwise the order is
      // accepted and simply never fills, with no error to explain why.
      const approvalTxHash = await maybeSendApproval(execution.approval);
      checkpoint();
      // Called as methods: a class-instance wallet needs its `this`.
      const approvalSignature = execution.approvalData ? await handlers.signTypedData(execution.approvalData) : undefined;
      checkpoint();
      const signature = await handlers.signTypedData(execution.typedData);
      checkpoint();
      // From here the venue may take the order even when the call fails (BUILD_FAILED, no answer),
      // so only a rate limit, refused before anything was placed, is retried.
      sent = true;
      report("swap_signed", { signature });
      const { statusRef } = await withRetries(() => client.submitSignature({ quoteToken, signature, approvalSignature }), rateLimited);
      report("swap_sent", { statusRef });
      return { execution, quoteToken, resetTxHash: partial.resetTxHash, approvalTxHash, statusRef, finalStatus: await pollStatus(statusRef) };
    }

    // DEPOSIT: nothing to sign or send from here; the user moves funds to execution.deposit.address
    // out-of-band, and this helper has no way to know when that happens. Returned without polling;
    // start polling yourself (getStatus / useRavnStatus) once the deposit is actually sent. Pay
    // `feePayment` as it says, pass an EVM fee transaction's hash as getStatus's `txHash`, and poll
    // RAVN to a terminal status even if the venue's own tracker says delivered first.
    // A fee it can't describe never stops the deposit, which fills without it.
    checkpoint();
    try {
      return { execution, quoteToken, statusRef: execution.statusRef, feePayment: depositFeePayment(execution) };
    } catch (feeError) {
      return { execution, quoteToken, statusRef: execution.statusRef, feeError };
    }
  };

  try {
    return await run();
  } catch (err) {
    if (stopCode) {
      const why = stopCode === "ABORTED" ? "aborted" : `no terminal status within maxWaitMs (${maxWaitMs} ms)`;
      throw new ExecuteAndTrackError(`executeAndTrack: ${why}`, stopCode, { ...partial }, stop.signal.reason);
    }
    if (!sent) throw err;
    const why = err instanceof Error ? err.message : String(err);
    throw new ExecuteAndTrackError(`executeAndTrack: ${why}`, "FAILED", { ...partial }, err);
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
