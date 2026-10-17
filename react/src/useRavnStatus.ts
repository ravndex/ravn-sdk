import { useEffect, useState } from "react";
import { RavnApiError, type RavnClient, type SettlementStatus, type StatusDTO } from "@ravnexchange/sdk";
import { isPollingTerminal } from "./polling";

export interface UseRavnStatusResult {
  status: StatusDTO | null;
  isLoading: boolean;
  error: unknown;
}

// Codes the API itself defines as request-shaped, not transient: retrying with the exact same
// arguments can never turn one of these into success. Anything else (RATE_LIMITED, INTERNAL, a
// network failure) is worth retrying through.
const PERMANENT_ERROR_CODES = new Set(["UNAUTHORIZED", "INVALID_REQUEST", "QUOTE_INVALID", "NOT_FOUND"]);

export function isPermanentError(err: unknown): boolean {
  return err instanceof RavnApiError && PERMANENT_ERROR_CODES.has(err.code);
}

/** Whether to poll again after `status`: until it's terminal, then once more after a success when
 * `txHash` is set, as RAVN's node may be a block behind yours on that fee tx and a success it
 * answers before seeing it books no fee. */
export function pollAgain(status: SettlementStatus, txHash: string | undefined, rechecked: boolean): boolean {
  return !isPollingTerminal(status) || (status === "success" && !!txHash && !rechecked);
}

/** How long to wait before the next poll after `status`: an expired swap's refund can take hours
 * (Across: a later settlement bundle), so it's asked about once a minute, not every few seconds. */
export function nextPollMs(status: SettlementStatus, intervalMs: number): number {
  return status === "expired" ? Math.max(intervalMs, 60_000) : intervalMs;
}

/**
 * Polls /v1/status until it reaches a terminal state (see isPollingTerminal: "unknown"
 * counts as terminal, it means the venue has no live tracker and never will for this swap;
 * "expired" doesn't, a refund is due, and is polled once a minute until it lands; nor does
 * "not_found", the venue hasn't seen the swap yet).
 * Pass `params: null` to not poll at all (e.g. before execution has produced a ref).
 * `txHash`: executeAndTrack's `statusTxHash`, or the fee payment a DEPOSIT's `fee.transaction`
 * asked for (or a two-hop route's hop-1 tx). Without it the swap's status still arrives, but its fee is never proven and nothing is owed.
 */
export function useRavnStatus(
  client: RavnClient,
  params: { quoteToken: string; ref: string; txHash?: string } | null,
  intervalMs = 4_000
): UseRavnStatusResult {
  const [status, setStatus] = useState<StatusDTO | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!params) {
      setStatus(null);
      return;
    }

    let cancelled = false;
    let rechecked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = () => {
      setIsLoading(true);
      client
        .getStatus(params.quoteToken, params.ref, params.txHash)
        .then((s) => {
          if (cancelled) return;
          setStatus(s);
          setError(null);
          if (pollAgain(s.status, params.txHash, rechecked)) {
            rechecked ||= isPollingTerminal(s.status);
            timer = setTimeout(poll, nextPollMs(s.status, intervalMs));
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err);
          // Keep polling through a transient network/5xx error rather than giving up on the
          // swap's status forever, but a permanent error (bad API key, invalid ref) can never
          // resolve by asking again with the same arguments, so stop rather than spam the API
          // for as long as the component happens to stay mounted.
          if (!isPermanentError(err)) {
            timer = setTimeout(poll, intervalMs);
          }
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });
    };

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, params?.quoteToken, params?.ref, params?.txHash, intervalMs]);

  return { status, isLoading, error };
}
