import { useCallback, useState } from "react";
import type { ExecuteParams, ExecutionDTO, RavnClient } from "@ravnexchange/sdk";

export interface UseRavnExecuteResult {
  execute: (params: ExecuteParams) => Promise<ExecutionDTO>;
  data: ExecutionDTO | null;
  isLoading: boolean;
  error: unknown;
}

/**
 * Thin state wrapper around client.execute(). Deliberately does NOT sign or send anything:
 * this package has no opinion on wallets. Branch on the returned executionType and hand it to
 * whatever signer the integrator already has (wagmi, ethers, a hardware wallet, ...).
 */
export function useRavnExecute(client: RavnClient): UseRavnExecuteResult {
  const [data, setData] = useState<ExecutionDTO | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const execute = useCallback(
    async (params: ExecuteParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await client.execute(params);
        setData(result);
        return result;
      } catch (err) {
        setError(err);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [client]
  );

  return { execute, data, isLoading, error };
}
