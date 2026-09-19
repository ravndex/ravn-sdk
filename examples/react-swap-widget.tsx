// Not runnable standalone: this is a copy-paste starting point for your own app. It needs a
// React tree with a real wallet already connected (wagmi, RainbowKit, whatever you use); the
// `signer` shown below is a stand-in for that.
//
// npm install @ravnexchange/sdk @ravnexchange/react

import { useState } from "react";
import { RavnClient, executeAndTrack, type ExecutionDTO } from "@ravnexchange/sdk";
import { useRavnQuote, useRavnExecute, useRavnStatus } from "@ravnexchange/react";

const client = new RavnClient();

// Replace with your actual wallet integration (e.g. wagmi's useSendTransaction/useSignTypedData).
declare const signer: {
  sendTransaction(tx: { to?: string; data?: string; value?: string }): Promise<string>;
  waitForReceipt(hash: string): Promise<void>;
  signTypedData(typedData: Record<string, unknown>): Promise<`0x${string}`>;
  address: string;
};

export function SwapWidget() {
  const [statusRef, setStatusRef] = useState<{ quoteToken: string; ref: string } | null>(null);

  const { quote, isLoading: quoting, isExpired } = useRavnQuote(client, {
    inputChainId: 1,
    outputChainId: 8453,
    inputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    outputToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    inputAmount: "1000000000000000000",
    userAddress: signer.address,
    destinationAddress: signer.address,
  });

  const { execute, isLoading: executing } = useRavnExecute(client);
  const { status } = useRavnStatus(client, statusRef);

  async function onSwap() {
    if (!quote) return;
    // executeAndTrack sequences approval -> wait-for-receipt -> main tx/signature -> polling for
    // you; skipping the approval wait is the most common hand-rolled-integration bug.
    const result = await executeAndTrack(
      client,
      { quoteToken: quote.quoteToken },
      {
        sendTransaction: (tx) => signer.sendTransaction(tx),
        waitForReceipt: (hash) => signer.waitForReceipt(hash),
        signTypedData: (typedData) => signer.signTypedData(typedData),
      },
      { pollUntilTerminal: false } // this example polls via useRavnStatus instead
    );
    if (result.statusRef) {
      setStatusRef({ quoteToken: quote.quoteToken, ref: result.statusRef });
    }
  }

  return (
    <div>
      {quoting && <p>Fetching quote...</p>}
      {quote && (
        <p>
          {quote.input.amount} {quote.input.token.symbol} &rarr; {quote.output.amount}{" "}
          {quote.output.token.symbol} via {quote.venue.name}
        </p>
      )}
      {isExpired && <p>Quote expired, fetch a new one before swapping.</p>}
      <button onClick={onSwap} disabled={!quote || isExpired || executing}>
        {executing ? "Swapping..." : "Swap"}
      </button>
      {status && <p>Status: {status.status}</p>}
    </div>
  );
}
