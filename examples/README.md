# Examples

- **`quote-and-execute.mjs`**: runnable as-is with `@ravnexchange/sdk`. `node quote-and-execute.mjs` after `npm install @ravnexchange/sdk`.
- **`quote_and_execute.py`**: the Python equivalent, runnable as-is with `ravnexchange`. `python quote_and_execute.py` after `pip install ravnexchange`.
- **`react-swap-widget.tsx`**: a copy-paste starting point using `@ravnexchange/react`'s hooks. Not runnable standalone; drop it into an app that already has a connected wallet.
- **`widget-embed.html`**: a plain HTML file (no build step) wiring `@ravnexchange/widget-connector` to an injected EVM wallet. Open it directly in a browser with MetaMask installed.

All four use the same example route (1 ETH on Ethereum to USDC on Base) so their output is easy to compare.
