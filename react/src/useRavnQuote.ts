import { useCallback, useEffect, useRef, useState } from "react";
import type { GetQuoteParams, QuoteDTO, RavnClient } from "@ravnexchange/sdk";
import { msUntilExpiry } from "./polling";

export interface UseRavnQuoteResult {
  quote: QuoteDTO | null;
  isLoading: boolean;
  error: unknown;
  /** True once quote.expiresAt has passed — stop letting the user sign, call refetch(). */
  isExpired: boolean;
  refetch: () => void;
}

/**
 * Fetches a quote and flips `isExpired` on its own timer when expiresAt passes — no polling,
 * just one setTimeout per quote. Pass `params: null` to skip fetching (e.g. amount not entered
 * yet). Does not auto-refetch on expiry: that's a UX choice (silently re-pricing behind a user's
 * back is worse than telling them to ask again), left to the caller.
 */
export function useRavnQuote(client: RavnClient, params: GetQuoteParams | null): UseRavnQuoteResult {
  const [quote, setQuote] = useState<QuoteDTO | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [isExpired, setIsExpired] = useState(false);
  const [generation, setGeneration] = useState(0);

  const paramsKey = params ? JSON.stringify(params) : null;

  const refetch = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    if (!params) {
      setQuote(null);
      setIsExpired(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setIsExpired(false);

    client
      .getQuote(params)
      .then((q) => {
        if (cancelled) return;
        setQuote(q);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // paramsKey (not params) drives refetch — a fresh object with the same fields shouldn't refire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, paramsKey, generation]);

  const expiresAt = quote?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(() => setIsExpired(true), msUntilExpiry(expiresAt));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return { quote, isLoading, error, isExpired, refetch };
}
