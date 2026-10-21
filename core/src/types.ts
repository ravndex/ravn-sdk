/**
 * Wire types for RAVN's public /api/v1 surface. Deliberately a standalone mirror of
 * src/lib/api/v1/dto.ts's public DTOs, not an import from it: this package ships to npm on
 * its own and can't depend on the app's internal source tree. The app type-checks this copy
 * against its own DTOs (dto-sdk-parity.ts), so a change on either side that isn't mirrored here
 * fails the app's build.
 */

export interface TokenDTO {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  chainId: number;
  isNative: boolean;
  logoUrl?: string;
}

export interface QuoteDTO {
  /** Opaque handle: pass back to execute() verbatim. Do not parse: usually a short id for the
   * quote RAVN keeps until 10 minutes past expiresAt, sometimes the whole signed quote. */
  quoteToken: string;
  venue: { id: string; name: string };
  routeType: string;
  input: { token: TokenDTO; amount: string };
  output: { token: TokenDTO; amount: string };
  /** What RAVN counts on this route delivering, in the output token's base units: `output.amount`, less
   * `slippage.expectedShortfallBps` when the venue holds no minimum (`slippage.noMinimum`, Rift); the
   * same as `output.amount` for every quote that holds one. RAVN ranks on this (less gas), so sort routes on
   * it, not `output.amount`, to compare them the way RAVN does. */
  expectedOutputAmount: string;
  /** `supported: false` means the venue has no fee mechanism at all (bps will be 0 either
   * way); distinct from `supported: true, bps: 0`, a real, intentional zero fee. On NEAR Intents
   * `bps`/`amount` include 1Click's own fee, taken from the input on every swap with or without
   * yours (the output already reflects it): 20 bps with no fee set (1 bp when both tokens are
   * USDC, USDT or DAI, or the same asset), with yours half of it plus the larger of that half and
   * 20 (1) bps, and its 20 (1) bps on top of RAVN's own fee beside a private swap: NEAR never
   * shows `bps: 0`. */
  fee: { bps: number; amount: string; token: TokenDTO; supported: boolean };
  /** False means this is a preview-only price; see RavnClient.getQuote's destinationAddress note. */
  executable: boolean;
  slippage: SlippageDTO | null;
  gas: { native: string; nativeSymbol: string; usd: string | null; estimated: boolean } | null;
  /** Same price source as `gas.usd`. Null when the token can't be priced. */
  inputUsd: string | null;
  outputUsd: string | null;
  estimatedTimeSeconds: number;
  estimatedTimeIsGuess: boolean;
  /** Epoch ms, always a real time: execute() on `quoteToken` before this, re-quote after. Never
   * refused for age before it. Up to 10 minutes past it, execute() prices the same route again and
   * builds it only if it still meets the minimum this quote showed (else QUOTE_EXPIRED; a quote with
   * slippage.noMinimum or no slippage is never re-priced). Already 5 s ahead of
   * the venue's own deadline, so compare it to the clock as is. 2-hop routes
   * (`venue.id === "compose"`) and venues with no deadline are never refused for age: it's 60 s
   * from the response, when to re-quote. A 2-hop route re-prices at execute (BUILD_FAILED if the
   * minimum shown can no longer be met). */
  expiresAt: number;
  /** Present on 2-hop (`venue.id === "compose"`) and Relay dest-call quotes. Sign hop 1; hop 2 is
   * a unique deposit, not a second wallet tx. The stablecoin route also sweeps its leftover through
   * 0x (`0x_swap`), which isn't listed here. */
  hops?: { id: string; name: string }[];
  /** Every other venue that raced and produced a usable quote, best output first. */
  alternatives: AlternativeQuoteDTO[];
}

export interface AlternativeQuoteDTO {
  venue: { id: string; name: string };
  routeType: string;
  /** Pass to execute() to run THIS route instead of the primary quote. */
  quoteToken: string;
  outputAmount: string;
  /** What RAVN counts on this route delivering, in the output token's base units: `outputAmount`, less
   * `slippage.expectedShortfallBps` when the venue holds no minimum (`slippage.noMinimum`, Rift); the
   * same as `outputAmount` for every quote that holds one. RAVN ranks on this (less gas), so sort routes on
   * it, not `outputAmount`, to compare them the way RAVN does. */
  expectedOutputAmount: string;
  /** `amount` is in `token`'s base units: the output token everywhere except Fly Trade and
   * Mayan, which deduct their fee from the input token. */
  fee: { bps: number; amount: string; token: TokenDTO; supported: boolean };
  executable: boolean;
  estimatedTimeSeconds: number;
  estimatedTimeIsGuess: boolean;
  /** This route's own execute deadline, same meaning as QuoteDTO.expiresAt. Venues differ, so
   * check it before executing an alternative. */
  expiresAt: number;
  hops?: { id: string; name: string }[];
  /** Same as QuoteDTO.slippage: an alternative can be executed, so it needs the same warning. */
  slippage: SlippageDTO | null;
}

/**
 * The slippage protection on a quote. `isFirm`: a firm RFQ price, no slippage possible.
 * `guaranteedMin`: the minimum output in the output token's base units, when the venue exposes it.
 *
 * `noMinimum: true` means the venue enforces NO minimum output (Rift: it fills at its own best
 * rate once the deposit lands), so `bps` is not a protection and the user can receive more or
 * less than the quoted output. Show that to the user before they send funds.
 */
export interface SlippageDTO {
  bps: number;
  isFirm: boolean;
  guaranteedMin: string | null;
  noMinimum: boolean;
  /** How far under its output RAVN counts on a route with no minimum delivering, in bps, from what
   * such routes have delivered: by swap size and whether both tokens are listed, from 5 (a $1k+ swap
   * of listed tokens) to 100 (under $100). 0 when `noMinimum` is false. `expectedOutputAmount`
   * already has it taken off. */
  expectedShortfallBps: number;
}

export interface ChainDTO {
  chainId: number;
  name: string;
  shortName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  explorerUrl: string;
  logoUrl?: string;
}

export interface ApprovalDTO {
  to: string;
  data: string;
  value: string;
  chainId?: number;
  spender?: string;
  amount: string;
  unlimitedRecommended?: boolean;
  /** Send this first and wait for it to be mined, then the approval: `approve(spender, 0)`. Only on
   * a token whose approve reverts on a change from one non-zero allowance to another (Ethereum
   * USDT) when the sender holds a partial one. executeAndTrack does this. */
  reset?: { to: string; data: string; value: string };
}

export type ExecutionDTO =
  | {
      executionType: "TRANSACTION";
      /** True for a sandbox quote: nothing here is real (see GetQuoteParams.sandbox); never send
       * it. executeAndTrack broadcasts nothing for one. */
      sandbox?: true;
      /** This swap's id in RAVN's ledger: settlement webhooks name it (`swapId`). Absent on a sandbox quote. */
      swapId?: string;
      /** Pass this, not the quote's own token, to getStatus. Compose: the post-bind token. */
      quoteToken: string;
      /** The venue's own tracking key (compose hop-2 handle, Garden order id, Relay request id).
       * Poll getStatus with this when present; otherwise use the origin tx hash. */
      statusRef?: string;
      approval?: ApprovalDTO;
      transaction: {
        to?: string;
        data?: string;
        value?: string;
        chainId?: number;
        serialized?: string;
      };
      /** Only on quotes made with `broadcastViaRavn: true`. Don't broadcast this one: sign
       * `transaction.serialized` and pass it to submitTransaction, which checks the signed
       * transaction still pays Layerswap the way it matches deposits, then sends it. */
      submit?: { url: string };
      /**
       * Only when your key sets a fee and the route has no fee of its own (Eco, Layerswap, Mayan's
       * routes paying no referrer, Fly Trade's coin sells where its own fee can't be proven:
       * Robinhood Chain, Arbitrum and others) from an EVM chain: RAVN's fee, a transfer of the input
       * token to RAVN, or on Robinhood Chain and Arbitrum a coin sell's fee as WETH minted to RAVN
       * (the coin sent to WETH's `depositTo`; `fee.token` in the quote is WETH); `transaction`
       * already leaves it out. From Solana there is none to send: the fee is a transfer inside
       * `transaction.serialized`. Skip it and the swap still fills; no fee is owed to you. A wallet
       * that batches (EIP-5792 `wallet_sendCalls`) or relays (smart account, 7702, 4337) may send
       * `fee.transaction` with `transaction` in one confirmation (one fee-bearing swap per
       * transaction: a second fee in it isn't proven), for an ERC-20 sell, or a coin sell whose fee
       * is WETH minted to RAVN (`batch` true; a native-coin fee must otherwise be a plain transaction
       * of its own, so a contract wallet that can't send one — a Safe, a 4337 account — can't pay
       * it). Pass the on-chain hash of the transaction that carried the fee (not an EIP-5792 batch id
       * or a 4337 userOpHash) as `txHash` to getStatus — not needed with no `statusRef` here, when
       * the fee rode in the swap's own transaction. Sent on its own, send it once the swap has
       * confirmed. A fee paid on a swap the venue refunds stays with RAVN.
       */
      fee?: DepositFeeDTO;
      /** EVM: everything to send, in order (approval.reset, approval, the swap or the deposit
       * transfer, RAVN's fee). Each once the one before has succeeded (stop if one reverts), or, when
       * `batch` is true, all in one atomic wallet batch (EIP-5792 `wallet_sendCalls`,
       * `atomicRequired: true`): simulate it first, and send them one by one if that fails or the
       * swap's call needs more than ~400k gas. */
      calls?: CallDTO[];
      /** Whether `calls` (more than one) may go in one atomic wallet batch. */
      batch?: boolean;
    }
  | {
      executionType: "SIGNATURE";
      /** True for a sandbox quote: nothing here is real (see GetQuoteParams.sandbox); never send
       * it. executeAndTrack broadcasts nothing for one. */
      sandbox?: true;
      /** This swap's id in RAVN's ledger: settlement webhooks name it (`swapId`). Absent on a sandbox quote. */
      swapId?: string;
      /** Pass this, not the quote's own token, to submitSignature and getStatus. */
      quoteToken: string;
      statusRef?: string;
      approval?: ApprovalDTO;
      typedData?: Record<string, unknown>;
      approvalData?: Record<string, unknown>;
      submit: { url: string; payload?: Record<string, unknown> };
    }
  | {
      executionType: "DEPOSIT";
      /** True for a sandbox quote: nothing here is real (see GetQuoteParams.sandbox); never send
       * it. executeAndTrack broadcasts nothing for one. */
      sandbox?: true;
      /** This swap's id in RAVN's ledger: settlement webhooks name it (`swapId`). Absent on a sandbox quote. */
      swapId?: string;
      /** Pass this, not the quote's own token, to getStatus. */
      quoteToken: string;
      /** `expiresAt` (ISO 8601), when set, is when the deposit must have ARRIVED (confirmed on
       * the origin chain) by. A later deposit lands at an expired order. */
      deposit: {
        address: string;
        amount: string;
        chainId?: number;
        expiresAt?: string;
        /** Bitcoin, from a native SegWit (bc1q…) userAddress: the deposit (and RAVN's fee as a second
         * output) as a ready-to-sign PSBT, base64, change back to it. Absent when it can't be built. */
        psbt?: string;
        /** Solana, when the deposit carries RAVN's fee: deposit and fee as one unsigned transaction,
         * base64. Sign and send it within a minute (its blockhash expires; a retry with the same
         * Idempotency-Key returns this same one). */
        transaction?: string;
      };
      /** Poll getStatus with this, not `deposit.address`. */
      statusRef: string;
      /** Only when your key sets a fee and the venue has no fee of its own (Rift; private swaps from
       * an EVM chain, Bitcoin or Solana). Skip it and the swap still fills on `deposit.amount`; no
       * fee is owed to you. A fee paid on a swap the venue then refunds stays with RAVN and nothing
       * is owed on it, so send an EVM fee payment once the deposit has confirmed. */
      fee?: DepositFeeDTO;
      /** EVM: everything to send, in order (approval.reset, approval, the swap or the deposit
       * transfer, RAVN's fee). Each once the one before has succeeded (stop if one reverts), or, when
       * `batch` is true, all in one atomic wallet batch (EIP-5792 `wallet_sendCalls`,
       * `atomicRequired: true`): simulate it first, and send them one by one if that fails or the
       * swap's call needs more than ~400k gas. */
      calls?: CallDTO[];
      /** Whether `calls` (more than one) may go in one atomic wallet batch. */
      batch?: boolean;
    };

/** One EVM transaction to send, as given. */
export interface CallDTO {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

/** RAVN's integrator fee beside a deposit (or a transaction), in the input token, paid by your user
 * to RAVN; your share is paid out as usual. `deposit.amount` (the transaction) already leaves it out. */
export interface DepositFeeDTO {
  /** Base units of the input token (the same in WETH, 18 decimals, where a coin sell's fee is
   * minted as WETH). */
  amount: string;
  /** RAVN's fee address on the input chain. */
  address: string;
  chainId: number;
  /** EVM: send this transaction too, exactly as given (it carries a tag naming this swap): on its
   * own, or in the same wallet batch or relay as the deposit or swap (EIP-5792, smart account, 7702,
   * 4337) — an ERC-20 fee anywhere, and a coin sell's fee minted to RAVN as WETH (Robinhood Chain,
   * Arbitrum: the coin sent to WETH's `depositTo`, booked and paid out in WETH, proven by WETH's
   * Transfer log wherever it rides); a native-coin fee only beside a NEAR Intents deposit on
   * Ethereum, Base or Polygon (proven from those chains' internal transfers). Any other native-coin
   * fee must be a plain transaction of its own (a contract wallet that can't send one can't pay it).
   * Then pass the on-chain hash of the transaction that carried it (not a batch id or a userOpHash)
   * as `txHash` to getStatus once it has confirmed (simplest: on every poll). One fee-bearing swap
   * per transaction: a batch carrying two fees, or a fee beside another fee-bearing swap, proves only
   * one. Batch a token deposit, or a native-coin deposit to NEAR Intents (it credits coin a smart
   * account moves); send any other native-coin deposit as a plain transfer, as an exchange may not
   * credit coin a contract moved. Absent on Bitcoin:
   * pay `amount` to `address` as an extra output of the SAME transaction that pays the deposit;
   * RAVN finds it there once that transaction confirms. One deposit per Bitcoin transaction: a fee
   * output proves one swap. Absent on Solana too: add the fee to the SAME transaction that pays the
   * deposit exactly `deposit.amount` (SOL as lamports to the deposit wallet, not wrapped) — SOL: a
   * System transfer of `amount` lamports to `address`; a token: `transferChecked` of `amount` to
   * `address`'s associated token account for the input mint (under the mint's token program), after
   * `createAssociatedTokenAccountIdempotent` in case RAVN has none for that token yet (its rent,
   * ~0.0015 SOL once per token, is normally in the quote's network cost). RAVN finds it there once
   * that transaction is finalized, among the deposit address's first and latest transactions; a fee
   * sent in a transaction of its own isn't found. One deposit per Solana transaction: a fee proves
   * one swap. It can't be sent after the deposit, so on a swap the venue refunds it stays with RAVN. */
  transaction?: { to: string; data: string; value: string; chainId: number };
}

export type SettlementStatus =
  | "pending"
  | "processing"
  | "expired"
  | "success"
  | "refunded"
  | "failed"
  | "not_found"
  | "unknown";

export interface StatusDTO {
  status: SettlementStatus;
  venue: string;
  venueStatus?: unknown;
  tracking?: "unavailable";
  /** Actual delivered output in the output token's base units, when the venue exposes it. */
  deliveredAmount?: string | null;
  /** The destination-chain tx that paid the user out, when the venue names one. */
  txHash?: string | null;
}

/** A venue's price as it lands in getQuoteStream: an alternative without its quoteToken, to show,
 * not to execute (only the quote getQuoteStream resolves to carries tokens). */
export type PriceDTO = Omit<AlternativeQuoteDTO, "quoteToken">;

/** What getQuoteStream reports while the race runs. `venues`: the venues racing. `settled`: one
 * venue answered (`quotes` empty: nothing usable). The winner is picked once, at the end, net of
 * gas: a venue that led here may not be it. */
export type QuoteStreamEvent =
  | { type: "venues"; venueIds: string[] }
  | { type: "settled"; venueId: string; quotes: PriceDTO[] };

export interface QuoteStreamOptions {
  /** Called with each event as it arrives. A throw here is ignored: it never costs the quote. */
  onEvent?: (event: QuoteStreamEvent) => void;
  signal?: AbortSignal;
}

export interface GetQuoteParams {
  inputChainId: number;
  outputChainId: number;
  inputToken: string;
  outputToken: string;
  /** Positive integer string, in the token's smallest unit (no decimals). */
  inputAmount: string;
  userAddress: string;
  /** Omitting this yields a preview-only quote; see QuoteDTO.executable. */
  destinationAddress?: string;
  refundAddress?: string;
  /** Max slippage in bps. Omitted = Auto (50, wider where a route needs it). Setting it keeps
   * venues with no minimum (slippage.noMinimum, today Rift) out of the race unless allowNoMinimum. */
  slippageBps?: number;
  /** Let venues with no minimum (today Rift) race even though slippageBps is set. Their quotes
   * carry slippage.noMinimum: true and guaranteedMin: null; slippageBps does not protect them. */
  allowNoMinimum?: boolean;
  rankingMode?: "best_output" | "fastest";
  /** The race's time limit in ms, counted from its start: once it has passed and some venue has
   * priced the swap, slower venues are left out (with none priced yet, the first price ends the
   * wait; a quote with slippage.noMinimum counts only 2000 ms past the limit). A positive integer;
   * default 6000, clamped to 1000–15000. An API that predates it ignores it. */
  timeoutMs?: number;
  /** Venues never to use, e.g. a risk objection to one of them. An excluded venue is used
   * nowhere in the route, including the steps of RAVN's multi-step routes (compose, relay quotes
   * with hops); a multi-step route that needs it isn't offered. Venues that swap for you may still
   * route through it on their own (see onlyVenues). */
  excludeVenues?: string[];
  /** Race only these venues, e.g. ["bebop"] for an RFQ-only race. Every other venue is left
   * out, including ones RAVN adds later; excludeVenues still applies on top. It covers every
   * venue RAVN routes funds through: a multi-step route is offered only when its own venue.id and
   * every venue in its hops are listed, e.g. ["compose", "jupiter", "relay"] or
   * ["relay", "kyberswap"]. RAVN's stablecoin route also needs "0x_swap" beside its hops: it
   * sweeps the leftover. Venues that swap for you may route through other venues of their own
   * choosing, which neither list can reach: Layerswap (a Solana token often goes through Jupiter
   * first), Relay, Rift, Across (when it swaps before or after bridging) and Mayan (Jupiter on
   * Solana, other DEXs such as Nordstern on EVM). An empty list is rejected (INVALID_REQUEST); if
   * none of them can quote, NO_LIQUIDITY lists every left-out venue in
   * error.details.excludedVenues. */
  onlyVenues?: string[];
  /** Settle privately: the race narrows to NEAR Intents (Confidential Intents) and Houdini Swap,
   * and NO_LIQUIDITY replaces a public fill if neither can quote. Houdini is sent the request's IP,
   * user-agent and clientTimezone for compliance screening; its terms bar US persons and
   * sanctioned jurisdictions, and you own your users' eligibility (excludeVenues: ["houdini"]). */
  confidential?: boolean;
  /** Your end user's IANA timezone (e.g. "Europe/Berlin"), forwarded only to Houdini. Default UTC. */
  clientTimezone?: string;
  /** Optional analytics handle: send the same value while re-pricing one swap so it counts as one
   * intent. Never affects pricing, routing or fees. Max 64 chars. */
  quoteSessionId?: string;
  /** Test quote -> execute -> status with no real funds and no live venue settlement. See
   * the API's own sandbox field description for per-venue/per-route exceptions. */
  sandbox?: boolean;
  /** Set if you can post a signed Solana transaction back (submitTransaction) instead of
   * broadcasting it yourself. Adds Layerswap's memo routes (Solana tokens into native BTC or
   * Robinhood Chain stocks, no account rent), which only work when RAVN checks the signed
   * transaction first: a TRANSACTION execution carrying `submit` must go through
   * submitTransaction. executeAndTrack does this when given signSolanaTransaction. */
  broadcastViaRavn?: boolean;
}

export interface ExecuteParams {
  quoteToken: string;
  /** Only venues that bind the recipient at execute (Chainflip, Houdini Swap, Layerswap, Mayan,
   * NEAR Intents, Rift) accept a new one; elsewhere a different address is INVALID_REQUEST. */
  destinationAddress?: string;
  refundAddress?: string;
  /** Your end user's IANA timezone, forwarded only to Houdini. Default UTC. */
  clientTimezone?: string;
  /** Sent as the Idempotency-Key header: any unique value per swap attempt (e.g. a UUID), 1–255
   * printable ASCII characters, no spaces (execute throws INVALID_REQUEST otherwise). Calling execute again with the same key and request (quoteToken and any addresses) within a day
   * returns the first answer instead of building again (at a deposit venue, a second deposit
   * address). executeAndTrack sends one itself when you don't. */
  idempotencyKey?: string;
}

export interface SubmitSignatureParams {
  quoteToken: string;
  signature: `0x${string}`;
  approvalSignature?: `0x${string}`;
}

export interface SubmitTransactionParams {
  /** The quoteToken execute() returned with that transaction, not the quote's own. */
  quoteToken: string;
  /** `transaction.serialized` after your user's wallet signed it, base64. */
  signedTransaction: string;
}

export interface ErrorMeta {
  requestId: string;
  version: string;
}

/** Every `code` the API sends (see the API's Errors page), plus NETWORK_ERROR: no response came
 * back at all (offline, DNS, CORS, a dropped connection). New codes can appear: compare against
 * these, don't switch on them exhaustively. */
export type RavnErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_TOKEN"
  | "UNSUPPORTED_CHAIN"
  | "NO_LIQUIDITY"
  | "QUOTE_EXPIRED"
  | "QUOTE_INVALID"
  | "QUOTE_NOT_EXECUTABLE"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "NOT_CONFIGURED"
  | "NOT_FOUND"
  | "BUILD_FAILED"
  | "VENUE_RATE_LIMITED"
  | "UNAVAILABLE"
  | "ORDER_REJECTED"
  | "INTERNAL"
  | "NETWORK_ERROR";

/** Thrown for every failed call: a non-2xx response, or none at all (NETWORK_ERROR). `code` is the
 * stable, machine-readable string from the API. */
export class RavnApiError extends Error {
  /** The HTTP status; undefined when no response came back (NETWORK_ERROR). */
  readonly status?: number;
  /** Seconds the API asked you to wait before trying the same call again (`details.retryAfterSec`,
   * sent with RATE_LIMITED, VENUE_RATE_LIMITED and UNAVAILABLE). */
  readonly retryAfterSec?: number;
  /** NETWORK_ERROR: the fetch error underneath. */
  declare readonly cause?: unknown;

  constructor(
    public readonly code: RavnErrorCode | (string & {}),
    message: string,
    public readonly details: unknown,
    public readonly meta: ErrorMeta | undefined,
    init: { status?: number; cause?: unknown } = {}
  ) {
    super(message);
    this.name = "RavnApiError";
    this.status = init.status;
    const retryAfterSec = (details as { retryAfterSec?: unknown } | null | undefined)?.retryAfterSec;
    this.retryAfterSec = typeof retryAfterSec === "number" ? retryAfterSec : undefined;
    if (init.cause !== undefined) this.cause = init.cause;
  }
}
