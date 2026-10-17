# RAVN integrator SDK

Four packages, each solving a different integrator's actual problem. None of them own wallet connection or transaction building; RAVN's `/api/v1` already returns exactly what to sign/send:

- **`core/`** (`@ravnexchange/sdk`): typed client for `/api/v1` (quote, execute, submit-signature, submit-transaction, status). Zero dependencies. What wallets and backend services use directly. Also exports `executeAndTrack()`, an optional helper that sequences approval → wait-for-receipt → main tx/signature → RAVN's fee → status polling given your own `sendTransaction`/`waitForReceipt`/`signTypedData` (and, for `broadcastViaRavn` quotes, `signSolanaTransaction`) functions. Skipping the approval wait is the most common integration bug; this just gets the order right without taking on an RPC dependency. From 0.2.0 it retries failed status calls (honouring `retryAfterSec`), reports every hash through `onProgress` as it happens, takes `signal`/`maxWaitMs`, and once anything is sent rejects only with an `ExecuteAndTrackError` whose `partial` holds every hash, so a swap is never lost. See [CHANGELOG.md](./CHANGELOG.md).
- **`react/`** (`@ravnexchange/react`): hooks built on `@ravnexchange/sdk` (`useRavnQuote`, `useRavnExecute`, `useRavnStatus`) for dapps building their own swap UI. Handles quote-expiry and status-polling state; still bring your own wallet. Works in React Native too: neither this package nor `@ravnexchange/sdk` touches `window`/`document`/any DOM API, and `@ravnexchange/sdk`'s `fetch` is injectable via `RavnClientConfig.fetch` for RN environments that need a polyfill.
- **`widget-connector/`** (`@ravnexchange/widget-connector`): host-side postMessage bridge for RAVN's embeddable swap widget, so the widget iframe can use the integrator's already-connected wallet instead of asking for a second connection. Two independent wallet lanes, EVM (`wallet:*`) and Solana (`solana:*`): a host can have either, both, or neither connected. No Bitcoin lane: RAVN's BTC flows are walletless (deposit-address based), so there's nothing for a connected Bitcoin wallet to sign. See `widget-connector/src/protocol.ts` for the wire format.
- **`python/`** (`ravnexchange` on PyPI): a Python mirror of `@ravnexchange/sdk`'s scope (quote, execute, submit-signature, submit-transaction, status, tokens, chains), zero runtime dependencies (`urllib.request`, not `requests`). Not an npm workspace member; separate toolchain, separate publish workflow. For a plain non-agent Python backend; an agent that already speaks MCP should use RAVN's MCP server instead, which already covers this and more.

## Status

Real npm workspaces (root `package.json`'s `workspaces` field) plus a per-package `tsc` build (`npm run build`, emitting `dist/`). `.github/workflows/publish-sdk.yml` publishes each of `core`/`react`/`widget-connector` to npm under the `ravnexchange` org on a push to `main` that bumps its `version`, skipping any version already on the registry, using trusted publishing (OIDC) with no stored npm token. Nothing publishes unless typecheck, the full test suite and every package's build pass on that commit first.

`python/` publishes separately to PyPI via `.github/workflows/publish-python-sdk.yml` on a push that bumps `python/pyproject.toml`'s version, using the same OIDC trusted-publishing model with a different toolchain (`hatchling` + `pypa/gh-action-pypi-publish`), after `python/tests` pass.

The widget iframe page itself, and the rest of RAVN's routing/execution engine, live in RAVN's main application, which is closed source. This repo only carries the client-side pieces an integrator embeds in their own project.

## Reading a quote

- **`slippage.noMinimum`**: `true` means the venue enforces no minimum output (today: Rift, which fills at its own best rate once the deposit lands). `slippage.bps` is then not a protection and the user can receive more or less than `output.amount`. Show this before the user sends funds. Alternatives carry the same field. Setting `slippageBps` keeps such venues out of the race; pass `allowNoMinimum: true` (0.1.11+) to let them race beside it.
- **`expired` and `not_found`** are not final: `expired` means a refund is due and the status becomes `refunded` when it lands (Across: hours later; poll about once a minute), `not_found` that the venue has no record of this swap: brief right after sending (Relay indexes seconds behind), otherwise permanent (the fill isn't this quote's swap). RAVN's final states are `success`, `refunded` and `failed`; `unknown` (no tracker) never changes either. `isPollingTerminal`, `executeAndTrack` and `useRavnStatus` keep polling `expired` and `not_found` (0.2.0 / react 0.1.7): bound `executeAndTrack` with `maxWaitMs` or `signal`.
- **Errors**: every failed call throws a `RavnApiError` with `code`, `status` (HTTP; undefined for `NETWORK_ERROR`, no response at all) and `retryAfterSec` (0.2.0+).
- **`hops`**: present on 2-hop (`venue.id === "compose"`) and Relay dest-call quotes. The user signs hop 1 only.
- **After `execute()`**: poll `getStatus` with the `quoteToken` that `execute()` returned, not the quote's own (compose rebinds it), and the execution's `statusRef` when present. `executeAndTrack()` does both and returns them.
- **RAVN's fee (`execution.fee`)**: on routes with no fee of their own (Rift, Eco, Layerswap, Mayan plain MCTP, private swaps) your fee is a separate payment, and none is owed to you unless it is paid the way `fee` says (on EVM, its transaction hash reported to `getStatus` as `txHash`). `executeAndTrack()` (0.1.15+) sends a TRANSACTION's `fee.transaction` once the swap confirms (or in the same confirmation via `sendCalls`, token fees only) and passes the right `txHash` on every poll, including a two-hop route's hop-1 tx. Its `waitForReceipt` must resolve to the receipt (viem's `waitForTransactionReceipt` and ethers' `wait()` do; from 0.2.0 one resolving to nothing doesn't compile): the fee is sent only when the swap's own receipt says success, never on one that reverted or was cancelled. For a DEPOSIT, `depositFeePayment(execution)` (also on the result as `feePayment`) says what to pay: an EVM transaction, or the extra output / transfer that must go in the same Bitcoin or Solana transaction as the deposit. Keep polling RAVN's `getStatus` to a terminal status even when the venue's own tracker (e.g. Rift's API) already says delivered: RAVN books the fee on its own status polls, and an EVM fee only on a poll made after its transaction confirmed. `txHash` must be the on-chain hash (`0x` + 64 hex), never an EIP-5792 batch id or a 4337 userOpHash.

## Embedding the widget

Point the `<iframe>` at `/widget/v1?origin=<your exact page origin>`. The version segment is
part of the contract: a future breaking change ships as `/widget/v2`, so an already-embedded
`v1` iframe keeps working unchanged. `/widget` (no version) always redirects to the latest
version, for quick manual testing only; don't embed that one in production.

```html
<iframe
  src="https://app.ravn.exchange/widget/v1?origin=https://your-site.example"
  sandbox="allow-scripts allow-same-origin allow-forms"
></iframe>
```

- **Keep `allow-same-origin`.** The bridge's trust model depends on the iframe reporting its
  real origin in every `postMessage` it sends. Both sides check `event.origin` against a
  pinned, exact value, not a wildcard. Sandboxing away `allow-same-origin` gives the iframe an
  opaque `"null"` origin and breaks that check, so the widget will never be able to talk to your
  bridge at all.
- **Don't add `allow-top-navigation` or `allow-popups`** unless you have a specific reason to:
  the widget never needs to navigate or open a window; every wallet action is relayed through
  `postMessage`, not a redirect or popup.
- On your own page, a CSP `frame-src` restricted to RAVN's widget origin (rather than `*`) is
  good hygiene: it stops your page from ever framing anything else under that directive by
  accident.
- RAVN's `/widget/*` route intentionally sends no `X-Frame-Options` / `frame-ancestors`
  restriction of its own; the whole point is that any integrator can embed it. Origin trust is
  enforced entirely at the application layer (the `?origin=` parameter plus the bridge's
  origin+source checks on every message), not by browser framing headers.

## Examples

Runnable, verified-working code for each package in [`examples/`](./examples): a Node script, a Python script, a React hooks snippet, and a plain-HTML widget embed.

## Playground

[ravndex.github.io/ravn-sdk](https://ravndex.github.io/ravn-sdk/) is a live version of the widget embed: connect a wallet, watch it bridge into the real widget iframe, copy the working code. It's not a config-knob playground (there's no theme/mode/variant to toggle yet; see `src/app/widget/v1/page.tsx` in the private app for what would need to change first); what's here is real and verified working, not a mockup.

## API reference

The full OpenAPI spec for `/api/v1` is published at [docs.ravn.exchange](https://docs.ravn.exchange).
