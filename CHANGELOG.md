# Changelog

`@ravnexchange/sdk` (core) unless a package is named. Merging a version bump to `main` publishes it
to npm (see `.github/workflows/publish-sdk.yml`).

## @ravnexchange/sdk 0.2.1

`executeAndTrack` can no longer lose a swap to a dropped `execute` answer, and every execution names
the swap RAVN's settlement webhooks are about.

### Added

- **`ExecutionDTO.swapId`**: this swap's id in RAVN's ledger. Settlement webhooks (`swap.settled`,
  `swap.refunded`, `swap.failed`) carry the same `swapId`, now for every final swap and retried
  for about a day. Absent on a sandbox quote.
- **`ExecuteParams.idempotencyKey`**, sent as the `Idempotency-Key` header: calling `execute` again
  with the same key and quoteToken within a day returns the first answer instead of building again
  (at a deposit venue, a second deposit address). The same key with another quoteToken is
  `INVALID_REQUEST`; a repeat while the first call is still running is `UNAVAILABLE` (retry after
  `retryAfterSec`).
- `executeAndTrack` sends one per call (yours, or a `crypto.randomUUID()`), and so now asks
  `execute` again when its answer was lost (`NETWORK_ERROR`, a 504) or is still being built
  (`UNAVAILABLE`), getting the same execution back. A `BUILD_FAILED` or an unexpected error is never
  repeated. Without `crypto.randomUUID`, only a rate limit is repeated, as before.
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
