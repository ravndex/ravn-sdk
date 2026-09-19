import { useEffect, useState } from "react";
import { RavnApiError, type RavnClient, type StatusDTO } from "@ravnexchange/sdk";
import { isPollingTerminal } from "./polling";

export interface UseRavnStatusResult {
  status: StatusDTO | null;
  isLoading: boolean;
  error: unknown;
}

// Codes the API itself defines as request-shaped, not transient — retrying with the exact same
// arguments can never turn one of these into success. Anything else (RATE_LIMITED, INTERNAL, a
// network failure) is worth retrying through.
const PERMANENT_ERROR_CODES = new Set(["UNAUTHORIZED", "INVALID_REQUEST", "QUOTE_INVALID", "NOT_FOUND"]);

export function isPermanentError(err: unknown): boolean {
  return err instanceof RavnApiError && PERMANENT_ERROR_CODES.has(err.code);
}

/**
 * Polls GET /v1/status until it reaches a terminal state (see isPollingTerminal — "unknown"
 * counts as terminal, it means the venue has no live tracker and never will for this swap).
 * Pass `params: null` to not poll at all (e.g. before execution has produced a ref).
 */
export function useRavnStatus(
  client: RavnClient,
  params: { quoteToken: string; ref: string } | null,
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
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = () => {
      setIsLoading(true);
      client
        .getStatus(params.quoteToken, params.ref)
        .then((s) => {
          if (cancelled) return;
          setStatus(s);
          setError(null);
          if (!isPollingTerminal(s.status)) {
            timer = setTimeout(poll, intervalMs);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err);
          // Keep polling through a transient network/5xx error rather than giving up on the
          // swap's status forever — but a permanent error (bad API key, invalid ref) can never
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
  }, [client, params?.quoteToken, params?.ref, intervalMs]);

  return { status, isLoading, error };
}
