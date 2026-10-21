# Changelog

`@ravnexchange/sdk` (core) unless a package is named. Merging a version bump to `main` publishes it
to npm (see `.github/workflows/publish-sdk.yml`).

## @ravnexchange/sdk 0.3.1, @ravnexchange/react 0.1.8

RAVN keys now come as a pair: a public key (`rvn_live_…`) for your app, browsers included, and a
secret key (`rvn_sk_…`) for your server, the only one that changes your fee, payout addresses or
webhook. See the API's Authentication page.

### Changed

- **`RavnClient` refuses a secret key in browser code** (throws at construction when `window` and
  `document` exist): pass your public key there. Servers are unaffected.
- `RavnErrorCode` gains `FORBIDDEN` (403): a public key where the secret key is needed, or a public
  key used from a site outside its allowed origins.
- **react:** `useRavnStatus` stops polling on `FORBIDDEN`, as on `UNAUTHORIZED`: retrying can't fix it.

## @ravnexchange/sdk 0.3.0

`execute()` checks what RAVN returns before it can reach a wallet. On EVM chains and Bitcoin, a
compromised or tampered answer can no longer use your integration to move more than the amount being
swapped (an allowance the user already gave the same venue contract elsewhere excepted). On Solana it
holds transactions to RAVN's venue programs and checks what their system and token instructions move;
a venue program's own instruction isn't read (see the README).

### Added

- **The check** (`checkExecution`, run by `RavnClient.execute`, so by `executeAndTrack` and
  `useRavnExecute` too): every transaction, approval, signature, Solana transaction and Bitcoin PSBT
  is held to the input token on the input chain, at most the input amount, venue contracts and
  programs RAVN routes through (a list per chain in this release), and RAVN's fee at most 1% to RAVN's
  own wallet. Throws `UnsafeExecutionError` (`code: "UNSAFE_EXECUTION"`) before anything is sent or
  signed. See the README's "The check before the wallet".
- `RavnClientConfig.guard`: `{ allowContracts }` to accept a venue's new contract before an SDK
  update, or `false` to turn the check off.
- `execute(params, { intent })` and `ExecuteAndTrackOptions.intent`: what the user asked to swap, for a
  quoteToken this client didn't fetch. Types `SwapIntent`, `GuardOptions`.

### Changed

- **`execute()` refuses a quoteToken this client didn't fetch unless you pass `intent`**, before calling
  the API. Quotes from `getQuote`/`getQuoteStream` (and their alternatives) on the same client are
  remembered, so the usual quote-then-execute flow needs no change. It also refuses a quote whose
  input token was given as a symbol rather than an address, and a quoteToken RAVN returned for two
  different requests.

## @ravnexchange/sdk 0.2.7

Every quote and route says what RAVN counts on it delivering, and each alternative whether RAVN
could have picked it, so you can choose a route the way RAVN does.

### Added

- **`expectedOutputAmount`** on `QuoteDTO`, `AlternativeQuoteDTO` and `PriceDTO`: the output
  RAVN counts on (base units). It equals the output for every quote that holds a minimum; for one
  that doesn't (`slippage.noMinimum`, Rift) it is the output less `slippage.expectedShortfallBps`.
  RAVN ranks on it less gas, so the order `alternatives` arrive in stays the closest match to RAVN's.
  Sorting on `outputAmount` instead can put a no-minimum route on top that RAVN ranked lower.
- **`slippage.expectedShortfallBps`** on `SlippageDTO`: that shortfall in bps, by swap size and
  whether both tokens are on RAVN's list (memes count as unlisted): 5 for a $1k+ swap of listed
  tokens, up to 100 under $100; 0 when the quote holds a minimum.
- **`pickable`** on `AlternativeQuoteDTO` (not `PriceDTO`): false for a preview-only price (while an executable route exists) and for a
  no-minimum route quoting more than 1% above every route that holds one, which RAVN lists but never
  picks. To choose a route yourself, pick among `pickable` ones on `expectedOutputAmount`.

### Upgrading

- The new fields are required on the types, so test fixtures typed as `QuoteDTO`,
  `AlternativeQuoteDTO`, `PriceDTO` or `SlippageDTO` need them added. Nothing else changes.
- The API sends the new fields from the matching ravn-mvp release. A client that validates
  responses strictly against an older copy of `openapi.json` (which sets `additionalProperties:
  false`) must refresh it.

## @ravnexchange/sdk 0.2.6

Show prices while RAVN's race runs. Nothing changes for code that doesn't call the new method.

### Added

- **`RavnClient.getQuoteStream(params, { onEvent, signal })`**: the quote `getQuote` returns, while
  `onEvent` hears each venue's prices as they land (`{ type: "venues", venueIds }`, then
  `{ type: "settled", venueId, quotes }` per venue; `quotes` are `PriceDTO`s, alternatives
  without a quoteToken, for display only). Uses the API's `stream: true`; an answer that isn't
  streamed (an older API, a proxy) is taken as a plain one. Types `PriceDTO`, `QuoteStreamEvent`,
  `QuoteStreamOptions`.

### Changed

- Type docs: `quoteToken` is usually a short id now; past `expiresAt`, execute re-prices the
  same route and goes ahead only if it still meets the minimum shown.

## @ravnexchange/sdk 0.2.5

`executeAndTrack` sends a TRANSACTION's swap and RAVN's fee in one wallet confirmation whenever
RAVN's execute says they may go together (`batch`), not only when the fee is a token.

### Changed

- **The fee batches when `batch` is true** (with a `sendCalls` handler): now also a coin sell's fee
  that RAVN takes as WETH minted to it (Fly Trade on Robinhood Chain and Arbitrum: the coin sent to
  WETH's `depositTo`), which its Transfer log proves inside the batch. One transaction carries the
  swap and the fee; its hash is the swap's `txHash` and `getStatus`'s `txHash` alike.
- **`batch: false` is followed too**: the fee goes as its own transaction after the swap's receipt,
  even a token fee. An execute answer without `batch` (older API) keeps 0.2.4's rule: a token fee
  batches, a coin fee never does.
- Type docs: the WETH fee on `fee` and `DepositFeeDTO`; the ~400k-gas guidance names the swap's call.

## @ravnexchange/sdk 0.2.4

`executeAndTrack` can send a DEPOSIT itself, RAVN's fee inside it, so you never build the fee
payment by hand on any route. Opt-in: without the new option nothing changes.

### Added

- **`ExecuteAndTrackOptions.sendDeposit`**: send a DEPOSIT from the ready-to-sign payload RAVN
  returns (0.2.2), then track it like any swap (polled to a terminal status, `txHash` set):
  - EVM `calls`: in one wallet confirmation through `sendCalls` when `batch` is true, else the
    deposit, its receipt, then RAVN's fee (a deposit that didn't succeed gets no fee). The fee's
    transaction is reported as `getStatus`'s `txHash`, as on a TRANSACTION.
  - Bitcoin `deposit.psbt` (the deposit and RAVN's fee output) through the new handler
    **`sendBitcoinPsbt(psbt)`**: sign, finalize, broadcast, return the txid.
  - Solana `deposit.transaction` (the deposit and RAVN's fee) through the new handler
    **`sendSolanaTransaction(serialized)`**: sign and send, return the signature, within about a
    minute of execute.
  A deposit it can't send comes back exactly as without the option (`feePayment`), with
  **`depositNotSent`** saying why: today a Bitcoin sender that isn't bc1q… (no PSBT), a Solana
  deposit with no RAVN fee (no transaction), a payload RAVN couldn't build in time, calls that
  aren't the deposit then the fee as given, no handler for its chain, or an execution type this
  version doesn't know. A sandbox deposit is never sent: its status is polled like any sandbox swap.
- **Turning it on**: send a deposit yourself only when the result has `depositNotSent`, or the user
  pays twice (a sandbox deposit has neither it nor `txHash`: it's never sent). Your
  `sendBitcoinPsbt` / `sendSolanaTransaction` should reject only when nothing was broadcast.

## @ravnexchange/sdk 0.2.3

`excludeVenues` and `onlyVenues` now cover every venue RAVN routes your funds through
(ravn-mvp #434). Types and docs only: no behaviour change in the client.

### Changed

- **`excludeVenues`**: an excluded venue is used nowhere in the route, including the steps of
  RAVN's multi-step routes (`compose`, and `relay` quotes with `hops`). A multi-step route that
  needs it isn't offered.
- **`onlyVenues`** no longer matches only the quote's `venue.id`: a multi-step route is offered
  only when its own id and every venue in its `hops` are listed, e.g. `["compose", "jupiter",
  "relay"]` or `["relay", "kyberswap"]`. RAVN's stablecoin route also needs `"0x_swap"` beside its
  hops (it sweeps the leftover). `["compose"]` alone now returns `NO_LIQUIDITY`.
- Venues that swap for you may still route through other venues of their own choosing, which
  neither list can reach: Layerswap (a Solana token often goes through Jupiter first), Relay,
  Rift, Across (when it swaps before or after bridging) and Mayan.

### Python (`ravnexchange`)

The same two comments updated in `client.py`; not republished (PyPI 0.1.6 predates `onlyVenues`).

## @ravnexchange/sdk 0.2.2

Executions come ready to sign, so you never build RAVN's fee payment yourself. Types only: no
behaviour change in the client.

### Added

- **`calls` and `batch`** on EVM `TRANSACTION` and `DEPOSIT` executions: every transaction to send,
  in order (`approval.reset`, `approval`, the swap, or the transfer of `deposit.amount` to
  `deposit.address`, then RAVN's fee), as `CallDTO` (`to`, `data`, `value`, `chainId`). Send each once
  the one before has succeeded (stop if one reverts), or all in one atomic wallet batch when `batch`
  is true (simulate first; send them one by one if that fails or the last call needs over ~400k gas).
- **`deposit.psbt`** on a Bitcoin `DEPOSIT` from a native SegWit (bc1q…) address: the deposit, RAVN's
  fee as a second output, and change back to your user's address, as a ready-to-sign PSBT (base64).
  Absent when it can't be built.
- **`deposit.transaction`** on a Solana `DEPOSIT` carrying RAVN's fee: the deposit and the fee as one
  unsigned transaction (base64), to sign and send within a minute.

## @ravnexchange/sdk 0.2.1

`executeAndTrack` can no longer lose a swap to a dropped `execute` answer, and every execution names
the swap RAVN's settlement webhooks are about.

### Added

- **`ExecutionDTO.swapId`**: this swap's id in RAVN's ledger. Settlement webhooks (`swap.settled`,
  `swap.refunded`, `swap.failed`) carry the same `swapId`, now for every final swap and retried
  for about a day. Absent on a sandbox quote.
- **`ExecuteParams.idempotencyKey`**, sent as the `Idempotency-Key` header: calling `execute` again
  with the same key and request (quoteToken and any addresses) within a day returns the first answer instead of building again
  (at a deposit venue, a second deposit address). The same key with another quoteToken or other
  addresses is `INVALID_REQUEST`; a repeat while the first call is still running is `UNAVAILABLE` (retry after
  `retryAfterSec`).
- `executeAndTrack` sends one per call (yours, or a `crypto.randomUUID()`), and so now asks
  `execute` again when its answer was lost (`NETWORK_ERROR`, a 504) or is still being built
  (`UNAVAILABLE`), getting the same execution back: up to 4 tries, so an execute that can't get
  through now fails after ~30 s at the default `pollIntervalMs` instead of at once (`signal` stops it
  sooner). A `BUILD_FAILED` or an unexpected error is never repeated. Without `crypto.randomUUID`
  (Node 18, a page on plain http, React Native), only a rate limit is repeated, as before.
- `execute` refuses an `idempotencyKey` the API would (not 1–255 printable ASCII characters, or with
  a space) with `INVALID_REQUEST`, before sending anything.
- `"UNAVAILABLE"` in `RavnErrorCode` (the API has answered it since 2026-10-17).

## @ravnexchange/sdk 0.2.0, @ravnexchange/react 0.1.7

`executeAndTrack` no longer loses a swap it has sent, and never fails silently.

### Breaking

- **`waitForReceipt` must resolve to the receipt.** It's typed
  `Promise<TransactionReceiptLike | null>` (`{ status, transactionHash }` or ethers v6's
  `{ status, hash }`), so an adapter resolving to nothing no longer compiles: since 0.1.15 such an
  adapter silently never got RAVN's fee sent. viem/wagmi `waitForTransactionReceipt`, ethers v5/v6
  `tx.wait()` / `provider.waitForTransaction` and web3.js receipts fit as they are: return them.
- **Once anything is sent or signed, `executeAndTrack` rejects only with an
  `ExecuteAndTrackError`**: `code` (`"FAILED"`, `"ABORTED"`, `"TIMEOUT"`), `partial` (everything
  sent or signed so far: `quoteToken`, `resetTxHash`, `approvalTxHash`, `txHash`, `statusRef`,
  `statusTxHash`, `feeTxHash`, `signedTransaction`, `signature`, `lastStatus`) and `cause` (the
  error underneath). That includes the wallet declining the swap
  after an approval was sent: read `err.cause` for the wallet's own error. Before anything is sent,
  errors come as before.
- **`expired` and `not_found` are no longer terminal**, matching RAVN's own final states (`success`,
  `refunded`, `failed`; `unknown` still stops: it never changes). `expired`: a refund is due and
  the status turns `refunded` when it lands (Across: hours later); `executeAndTrack` polls it once
  a minute (`expiredPollIntervalMs`), as does `useRavnStatus` (react 0.1.7). `not_found`: the venue
  has no record of this swap, brief right after sending (Relay indexes seconds behind: 0.1.15
  ended most Relay swaps on their first poll), otherwise permanent (the fill isn't this quote's
  swap); polled at the normal interval until `signal` or `maxWaitMs` stops it, like one stuck
  `pending`. Set `maxWaitMs` on a backend.
- **A network failure is a `RavnApiError`** with `code: "NETWORK_ERROR"` and the fetch error as
  `cause`, never a raw `TypeError`.
- **@ravnexchange/react 0.1.7 needs @ravnexchange/sdk >=0.2.0** (peer): with an older sdk,
  `isPollingTerminal` still stops on `expired`.

### Added

- Retries: status polls and `submitTransaction` retry a 429, a 5xx or a network failure (backoff
  doubling from `pollIntervalMs` up to a minute, or the API's `details.retryAfterSec`, up to 8
  attempts). `execute` and `submitSignature` retry only a rate limit: a `BUILD_FAILED` execute
  wants a fresh quote (and a repeat can open a second venue order), and a `BUILD_FAILED` signature
  may already be placed.
- `onProgress({ stage, partial })`: every hash the moment it exists (`reset_sent`, `approval_sent`,
  `swap_signed` with the signed Solana transaction for broadcastViaRavn, `swap_sent` with
  `statusRef`, `fee_sent`) and every status poll (`status`). Persist `partial` to resume tracking
  if the call never returns. A failing `submitTransaction` keeps `partial.signedTransaction` (post
  it again: RAVN never sends it twice) and any `txHash` RAVN's error names; a failing
  `submitSignature` keeps `partial.signature` (the venue may hold the order: check before signing
  a new one). Stage `swap_signed` reports either. A hook that throws or rejects (an async database
  write) is ignored, never an unhandled rejection.
- `signal` (AbortSignal) and `maxWaitMs` options. Abort sends nothing more to the wallet; neither
  withdraws a wallet prompt already open. An execute, allowance read, receipt wait or status call is
  cut off even when the wallet or a custom `fetch` ignores the signal; one that rejects later is
  handled. A submitSignature/submitTransaction already under way is awaited: its answer is the
  swap's only handle.
- `RavnApiError.status` (HTTP status) and `RavnApiError.retryAfterSec`; `code` is typed
  `RavnErrorCode` (the API's codes plus `NETWORK_ERROR`), still open to new strings.
- `getStatus(quoteToken, ref, txHash, { signal })`.
- `GetQuoteParams.timeoutMs`: the quote race's time limit (default 6000, clamped 1000–15000; ravn-mvp
  #418). An API that predates it ignores it.
- With `sendCalls`, a swap's approval joins the batch that already carries a token-paid RAVN fee
  (approve + swap + fee in one confirmation). Only there: `ExecutionDTO` doesn't name its venue,
  and the first-party app never batches THORChain or Bebop, which aren't fee-beside routes.
- Mirrors ravn-mvp's new execute fields: `ApprovalDTO.reset` (`approve(spender, 0)` first, Ethereum
  USDT), sent and confirmed before the approval (first in a batch), its hash as `resetTxHash`;
  `ExecutionDTO.sandbox`: on a sandbox TRANSACTION or SIGNATURE, `executeAndTrack` asks the
  wallet for nothing (no approval, swap, fee or signature: a venue with no sandbox stand-in returns
  its live payload), submits nothing, and polls RAVN's synthetic sandbox status. A sandbox DEPOSIT
  returns like any DEPOSIT (nothing is sent from here either way).
- `QuoteDTO.fee` doc: on NEAR Intents it includes 1Click's own fee (comment only).

### Python (`ravnexchange`)

Unchanged and not republished; see its README's "Parity" section for what it lacks.

## Earlier

- **0.1.15**: `executeAndTrack` sends a TRANSACTION's `fee.transaction` once the swap's own receipt
  says success (batchable via `sendCalls`) and reports its `txHash` on every poll;
  `depositFeePayment()`. Before it, `executeAndTrack` never paid RAVN's fee.
- **0.1.14**: TRANSACTION `fee` (Eco, Layerswap). **0.1.13**: DEPOSIT `fee`, `getStatus` `txHash`.
- **0.1.12**: `RavnClient` works in browsers without a custom fetch. Up to 0.1.11 every browser
  call failed ("Illegal invocation").
- **0.1.11**: `allowNoMinimum`. **0.1.10**: `broadcastViaRavn`, `submitTransaction`.
  **0.1.7–0.1.9**: mirror the /v1 API (noMinimum, hops, execution quoteToken/statusRef,
  request params, status over POST, alternatives' expiresAt).
