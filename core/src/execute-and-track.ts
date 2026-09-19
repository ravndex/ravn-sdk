import type { RavnClient } from "./client";
import type { ApprovalDTO, ExecuteParams, ExecutionDTO, StatusDTO } from "./types";
import { isPollingTerminal } from "./polling";

type TxLike = { to?: string; data?: string; value?: string; chainId?: number; serialized?: string };

export interface ExecuteAndTrackHandlers {
  /** Broadcast a transaction (an approval, or the main swap tx) and return its hash. */
  sendTransaction(tx: TxLike): Promise<string>;
  /**
   * Wait for a transaction hash to confirm. Called on the approval before the main tx is ever
   * sent: sending both back-to-back races the allowance and is the most common integration bug
   * this helper exists to prevent.
   */
  waitForReceipt(hash: string, chainId?: number): Promise<void>;
  /** Sign an EIP-712 typed-data payload. Only called for SIGNATURE executions. */
  signTypedData?(typedData: Record<string, unknown>): Promise<`0x${string}`>;
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
  /** Pass to client.getStatus(quoteToken, ref): same value as txHash for TRANSACTION. */
  statusRef?: string;
  /** Set once pollUntilTerminal reaches a terminal status. Absent for DEPOSIT (see below) or when polling is turned off. */
  finalStatus?: StatusDTO;
}

/**
 * Sequences execute() → approval (if any) → wait for its receipt → main tx/signature → status
 * polling, using caller-supplied signing/sending functions. The SDK stays wallet-agnostic (no
 * RPC dependency); this just gets the ORDER right, which quickstart's own docs flag as the
 * most common integration failure: sending the main tx before the approval has confirmed.
 */
export async function executeAndTrack(
  client: RavnClient,
  params: ExecuteParams,
  handlers: ExecuteAndTrackHandlers,
  options: ExecuteAndTrackOptions = {}
): Promise<ExecuteAndTrackResult> {
  const { pollUntilTerminal = true, pollIntervalMs = 4_000 } = options;
  const execution = await client.execute(params);

  const pollStatus = async (ref: string): Promise<StatusDTO | undefined> => {
    if (!pollUntilTerminal) return undefined;
    for (;;) {
      const status = await client.getStatus(params.quoteToken, ref);
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

  if (execution.executionType === "TRANSACTION") {
    const approvalTxHash = await maybeSendApproval(execution.approval);
    const txHash = await handlers.sendTransaction(execution.transaction);
    return { execution, approvalTxHash, txHash, statusRef: txHash, finalStatus: await pollStatus(txHash) };
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
    const { statusRef } = await client.submitSignature({ quoteToken: params.quoteToken, signature, approvalSignature });
    return { execution, approvalTxHash, statusRef, finalStatus: await pollStatus(statusRef) };
  }

  // DEPOSIT: nothing to sign or send from here; the user moves funds to execution.deposit.address
  // out-of-band, and this helper has no way to know when that happens. Returned without polling;
  // start polling yourself (getStatus / useRavnStatus) once the deposit is actually sent.
  return { execution, statusRef: execution.statusRef };
}
