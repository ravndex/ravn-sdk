import { useCallback, useState } from "react";
import type { ExecuteParams, RavnClient } from "@ravnexchange/sdk";

/** Whatever the installed SDK's execute() answers: from sdk 0.4.0, an AuthorizeDTO too. */
type Execution = Awaited<ReturnType<RavnClient["execute"]>>;

export interface UseRavnExecuteResult {
  execute: (params: ExecuteParams) => Promise<Execution>;
  data: Execution | null;
  isLoading: boolean;
  error: unknown;
}

/**
 * Thin state wrapper around client.execute(). Deliberately does NOT sign or send anything:
 * this package has no opinion on wallets. Branch on the returned executionType (an AUTHORIZE:
 * have the wallet sign it, then execute again with its authorization and the signature) and hand it to
 * whatever signer the integrator already has (wagmi, ethers, a hardware wallet, ...).
 */
export function useRavnExecute(client: RavnClient): UseRavnExecuteResult {
  const [data, setData] = useState<Execution | null>(null);
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
