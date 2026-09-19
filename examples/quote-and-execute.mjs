// Runnable as-is: `npm install @ravnexchange/sdk && node quote-and-execute.mjs`
//
// Shows the read-only half of the API (getChains, getTokens, getQuote), which needs no wallet
// and no API key, plus the shape of the execute() call an integrator wires up next. Signing and
// sending are left to your own wallet/signer, since @ravnexchange/sdk is deliberately
// wallet-agnostic; see executeAndTrack() in @ravnexchange/sdk for the full
// approve -> wait -> sign/send -> poll sequence once you have one.

import { RavnClient } from "@ravnexchange/sdk";

const client = new RavnClient(); // omit apiKey for the anonymous tier

const chains = await client.getChains();
console.log(`RAVN lists tokens on ${chains.length} chains, e.g. ${chains[0].name}`);

const quote = await client.getQuote({
  inputChainId: 1, // Ethereum
  outputChainId: 8453, // Base
  inputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // native ETH
  outputToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base USDC
  inputAmount: "1000000000000000000", // 1 ETH, in wei
  // A placeholder that isn't a real 0x address (even one you don't own) fails as NO_LIQUIDITY,
  // not a clear validation error; replace this with your own address before executing for real.
  userAddress: "0x000000000000000000000000000000000000dEaD",
  // Omitting destinationAddress/refundAddress makes this a preview-only quote
  // (quote.executable === false), fine for just showing a price, not enough to execute.
});

console.log(
  `Quote: ${quote.input.amount} ${quote.input.token.symbol} -> ${quote.output.amount} ${quote.output.token.symbol}` +
    ` via ${quote.venue.name}, executable=${quote.executable}`
);

if (quote.executable) {
  // Real usage: const execution = await client.execute({ quoteToken: quote.quoteToken });
  // then branch on execution.executionType (TRANSACTION / SIGNATURE / DEPOSIT) and hand it to
  // your wallet; see executeAndTrack() for that whole sequence in one call.
  console.log("Ready to execute; call client.execute({ quoteToken: quote.quoteToken }) next.");
}
