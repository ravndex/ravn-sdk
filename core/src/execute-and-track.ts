import type { RavnClient } from "./client";
import type { ApprovalDTO, DepositFeeDTO, ExecuteParams, ExecutionDTO, StatusDTO } from "./types";
import { isPollingTerminal } from "./polling";

type TxLike = { to?: string; data?: string; value?: string; chainId?: number; serialized?: string };

export interface ExecuteAndTrackHandlers {
  /** Broadcast a transaction (an approval, the main swap tx, or RAVN's fee) and return its hash. */
  sendTransaction(tx: TxLike): Promise<string>;
  /**
   * Wait for a transaction hash to confirm. Called on the approval before the main tx is ever
   * sent: sending both back-to-back races the allowance and is the most common integration bug
   * this helper exists to prevent. Also called on the swap before RAVN's fee is sent on its own
   * (`fee.transaction`), which is only ever sent on a swap that went through: reject when the
   * transaction reverted, was dropped or was cancelled/replaced by another one, or resolve to the
   * receipt itself (viem's `waitForTransactionReceipt` and ethers' `wait()` do), whose `status`
   * is then checked.
   */
  waitForReceipt(hash: string, chainId?: number): Promise<unknown>;
  /**
   * Optional: send several calls in ONE wallet confirmation that succeeds or fails as a whole
   * (EIP-5792 `wallet_sendCalls` with `atomicRequired: true`, a smart account) and resolve, once
   * they have landed, to the on-chain hash of the transaction that carried each call, in order
   * (the same hash repeated for one transaction). Not a batch id or a 4337 userOpHash: RAVN
   * proves its fee from that transaction. When given, a token-paid RAVN fee rides in the swap's
   * own confirmation; a native-coin fee is always a plain transaction of its own.
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

export interface ExecuteAndTrackOptions {
  /** Default true. Set false to get a ref back immediately and poll getStatus yourself. */
  pollUntilTerminal?: boolean;
  pollIntervalMs?: number;
}

export interface ExecuteAndTrackResult {
  execution: ExecutionDTO;
  approvalTxHash?: string;
  txHash?: string;
  /** Pass to client.getStatus(quoteToken, statusRef). Same as `execution.quoteToken`, NOT the
   * quote's own token: on compose (2-hop) quotes execute rebinds hop 1 onto hop 2's deposit. */
  quoteToken: string;
  /** Pass to client.getStatus(quoteToken, statusRef). For TRANSACTION, the execution's own
   * statusRef when it has one (compose, Garden, Relay), else txHash: not always a tx hash. */
  statusRef?: string;
  /** Pass as getStatus's third argument (`txHash`) on every poll you make yourself: the fee
   * payment's transaction when one was sent, else a two-hop route's hop-1 tx. It's how RAVN proves
   * the fee your share is paid from. */
  statusTxHash?: string;
  /** The transaction that carried RAVN's fee (`execution.fee.transaction`), once sent. */
  feeTxHash?: string;
  /** Why RAVN's fee wasn't sent (or its receipt not seen): the swap still runs and is tracked, but
   * no fee is owed to you on it unless `feeTxHash` is set and it landed. */
  feeError?: unknown;
  /** DEPOSIT only: the fee payment to make beside the deposit (see depositFeePayment). */
  feePayment?: DepositFeePayment;
  /** Set once pollUntilTerminal reaches a terminal status. Absent for DEPOSIT (see below) or when polling is turned off. */
  finalStatus?: StatusDTO;
}

/** How to pay a DEPOSIT's `fee`, so it's proven against this swap. See DepositFeeDTO. */
export type DepositFeePayment =
  /** EVM: send `transaction` exactly as given once the deposit has confirmed, then pass its hash as
   * `txHash` to getStatus. A token fee (`value` "0") may instead ride in the deposit's own wallet
   * batch; pass the on-chain hash of the transaction that carried it. */
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

/** The fee payment a DEPOSIT execution asks for beside its deposit; undefined when it has none. */
export function depositFeePayment(execution: ExecutionDTO): DepositFeePayment | undefined {
  if (execution.executionType !== "DEPOSIT" || !execution.fee) return undefined;
  const { transaction, address, amount, chainId } = execution.fee;
  if (transaction) return { kind: "transaction", transaction };
  if (chainId === BITCOIN_CHAIN_ID) return { kind: "bitcoin_output", address, amount };
  if (chainId === SOLANA_CHAIN_ID) return { kind: "solana_transfer", address, amount };
  throw new Error(`depositFeePayment: no known way to pay a fee on chain ${chainId}`);
}

// A receipt that names a status must say success: viem "success", ethers 1 (web3.js 1n/true; == on purpose).
const receiptSucceeded = (receipt: unknown): boolean => {
  const status = (receipt as { status?: unknown } | null | undefined)?.status;
  return status === undefined || status === "success" || status == 1;
};

/**
 * Sequences execute() → approval (if any) → wait for its receipt → main tx/signature → RAVN's fee
 * payment (if any) → status polling, using caller-supplied signing/sending functions. The SDK
 * stays wallet-agnostic (no RPC dependency); this just gets the ORDER right, which quickstart's
 * own docs flag as the most common integration failure: sending the main tx before the approval
 * has confirmed.
 */
export async function executeAndTrack(
  client: RavnClient,
  params: ExecuteParams,
  handlers: ExecuteAndTrackHandlers,
  options: ExecuteAndTrackOptions = {}
): Promise<ExecuteAndTrackResult> {
  const { pollUntilTerminal = true, pollIntervalMs = 4_000 } = options;
  const execution = await client.execute(params);
  const { quoteToken } = execution;

  const pollStatus = async (ref: string, txHash?: string): Promise<StatusDTO | undefined> => {
    if (!pollUntilTerminal) return undefined;
    for (;;) {
      const status = await client.getStatus(quoteToken, ref, txHash);
      if (isPollingTerminal(status.status)) return status;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };

  // Sends and confirms an approval unless the caller already knows it's covered; see
  // ExecuteAndTrackHandlers.hasAllowance's doc comment for why the API can't decide this itself.
  const maybeSendApproval = async (approval: ApprovalDTO | undefined): Promise<string | undefined> => {
    if (!approval) return undefined;
    if (await handlers.hasAllowance?.(approval)) return undefined;
    const hash = await handlers.sendTransaction(approval);
    await handlers.waitForReceipt(hash, approval.chainId);
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
    const signedTransaction = await handlers.signSolanaTransaction(execution.transaction.serialized);
    const { txHash } = await client.submitTransaction({ quoteToken, signedTransaction });
    const statusRef = execution.statusRef ?? txHash;
    return { execution, quoteToken, txHash, statusRef, finalStatus: await pollStatus(statusRef) };
  }

  if (execution.executionType === "TRANSACTION") {
    const approvalTxHash = await maybeSendApproval(execution.approval);
    // RAVN's fee, when the route has none of its own (Eco, Layerswap, Mayan plain MCTP). From
    // Solana there's nothing to send: it's a transfer inside transaction.serialized.
    const feeTx = execution.fee?.transaction;
    let txHash: string;
    let feeTxHash: string | undefined;
    let feeError: unknown;
    if (feeTx && BigInt(feeTx.value) === 0n && handlers.sendCalls) {
      // A token fee may ride in the swap's own confirmation: atomic, so it never outlives a swap
      // that reverted. One hash back means one transaction carried both.
      const [swapHash, feeHash = swapHash] = await handlers.sendCalls([execution.transaction, feeTx]);
      if (!swapHash) throw new Error("executeAndTrack: sendCalls returned no transaction hash");
      txHash = swapHash;
      feeTxHash = feeHash;
    } else {
      txHash = await handlers.sendTransaction(execution.transaction);
      if (feeTx) {
        // On its own, only once the swap has confirmed: a reverted, dropped or replaced one pays
        // no fee. Declined or failed, the swap still runs and is tracked; no fee is owed on it.
        try {
          if (!receiptSucceeded(await handlers.waitForReceipt(txHash, execution.transaction.chainId))) {
            throw new Error("executeAndTrack: the swap transaction did not succeed, so RAVN's fee was not sent");
          }
          feeTxHash = await handlers.sendTransaction(feeTx);
          // Confirmed before polling starts: a swap that fills first would otherwise end the
          // polling on the one poll that had to prove the fee.
          await handlers.waitForReceipt(feeTxHash, feeTx.chainId);
        } catch (err) {
          feeError = err;
        }
      }
    }
    const statusRef = execution.statusRef ?? txHash;
    // What proves the fee: its own transaction, else (a statusRef: a two-hop route) hop 1's. EVM
    // hashes only: a Solana signature proves nothing there.
    const statusTxHash = feeTxHash ?? (execution.statusRef && !execution.transaction.serialized ? txHash : undefined);
    return {
      execution, quoteToken, approvalTxHash, txHash, statusRef, statusTxHash, feeTxHash, feeError,
      finalStatus: await pollStatus(statusRef, statusTxHash),
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
    let approvalSignature: `0x${string}` | undefined;
    if (execution.approvalData) {
      approvalSignature = await handlers.signTypedData(execution.approvalData);
    }
    const signature = await handlers.signTypedData(execution.typedData);
    const { statusRef } = await client.submitSignature({ quoteToken, signature, approvalSignature });
    return { execution, quoteToken, approvalTxHash, statusRef, finalStatus: await pollStatus(statusRef) };
  }

  // DEPOSIT: nothing to sign or send from here; the user moves funds to execution.deposit.address
  // out-of-band, and this helper has no way to know when that happens. Returned without polling;
  // start polling yourself (getStatus / useRavnStatus) once the deposit is actually sent. Pay
  // `feePayment` as it says, and pass an EVM fee transaction's hash as getStatus's `txHash`.
  return { execution, quoteToken, statusRef: execution.statusRef, feePayment: depositFeePayment(execution) };
}
