/**
 * Wire types for RAVN's public /api/v1 surface. The response types are generated from RAVN's API
 * spec (core/openapi.json, a copy of https://app.ravn.exchange/openapi.json) into
 * ./generated/openapi.ts: never edit that file. `npm run sync:spec` fetches the live spec and
 * regenerates; CI fails if the generated file doesn't match the copy. The request params below stay
 * hand-written on purpose: looser than the spec (any chain id or venue id), so a new chain or venue
 * never needs an SDK upgrade.
 */
import type { components } from "./generated/openapi";

type Schemas = components["schemas"];
// Object types are interfaces over the generated ones, as they were when hand-written: hovers and an
// integrator's emitted .d.ts name them (QuoteDTO, not its expanded shape), and `declare module`
// augmentation still works. Error messages and nested fields still show the expanded shape: the
// generator names nothing inside `components`. Unions stay type aliases. `Schema<K>` because an
// interface can't extend an indexed access type directly.
type Schema<K extends keyof Schemas> = Schemas[K];

export interface TokenDTO extends Schema<"TokenDTO"> {}

/** A venue RAVN routes through. */
export interface VenueDTO extends Schema<"VenueDTO"> {}

export interface QuoteDTO extends Schema<"QuoteDTO"> {}

export interface AlternativeQuoteDTO extends Schema<"AlternativeQuoteDTO"> {}

/** The slippage protection on a quote. With `noMinimum: true` there is no guaranteed minimum: show
 * that to the user before they send funds. */
export interface SlippageDTO extends Schema<"SlippageDTO"> {}

export interface ChainDTO extends Schema<"ChainDTO"> {}

export interface ApprovalDTO extends Schema<"ApprovalDTO"> {}

/** What execute() returns, tagged by `executionType`. */
export type ExecutionDTO = Schemas["ExecutionDTO"];

/**
 * execute()'s answer when the swap needs your user's signature before it can be built (Hinkal, a
 * private swap): no funds move by signing it. Have the paying wallet (the quote's `userAddress`)
 * sign `sign` (`personal_sign` the `message`, or `eth_signTypedData_v4` the `typedData` with the
 * wallet on the input chain), then call execute() again with the same `quoteToken`, this
 * `authorization` and the `signature`, before `expiresAt`. Repeat until a TRANSACTION comes back
 * (`step` of `steps`), and send that within 10 minutes of the typed-data step's arrival (RAVN
 * refuses an order signed with under 4 minutes of that left: execute again). execute() checks each
 * one first (unless `guard: false`): the `personal_sign` opens a read-only Hinkal session, never one
 * that can move funds; the typed data places an order for the input token, at most the input amount,
 * paying the one recipient quoted. executeAndTrack does all of this. RAVN offers Hinkal only on a
 * quote sent with `authorizeSteps: true`.
 */
export interface AuthorizeDTO extends Schema<"AuthorizeDTO"> {}

/** One EVM transaction to send, as given. */
export interface CallDTO extends Schema<"CallDTO"> {}

/** RAVN's integrator fee beside a deposit (or a transaction), in the input token, paid by your user
 * to RAVN; your share is paid out as usual. `deposit.amount` (the transaction) already leaves it out. */
export interface DepositFeeDTO extends Schema<"DepositFeeDTO"> {}

export type SettlementStatus = Schemas["NormalizedStatus"];

export interface StatusDTO extends Schema<"StatusDTO"> {}

/** A venue's price as it lands in getQuoteStream: an alternative without its quoteToken, to show,
 * not to execute (only the quote getQuoteStream resolves to carries tokens). */
export interface PriceDTO extends Schema<"PriceDTO"> {}

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
  /** Settle privately: the race narrows to NEAR Intents (Confidential Intents), Houdini Swap and,
   * with authorizeSteps, Hinkal, and NO_LIQUIDITY replaces a public fill if none can quote. Houdini is
   * sent the request's IP, user-agent and clientTimezone for compliance screening; its terms bar US
   * persons and sanctioned jurisdictions, and you own your users' eligibility (excludeVenues:
   * ["houdini"], ["hinkal"]). */
  confidential?: boolean;
  /** Your execute flow answers AUTHORIZE steps (see AuthorizeDTO): executeAndTrack does, given
   * signMessage and signTypedData. Without it (or onlyVenues naming "hinkal") a confidential race
   * leaves out Hinkal, whose swap needs two such signatures. */
  authorizeSteps?: boolean;
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
  /** Answering an AUTHORIZE: its `authorization`, with `signature`, the paying wallet's signature
   * over its `sign`. Send each answer with an idempotencyKey of its own. */
  authorization?: string;
  signature?: `0x${string}`;
}

export interface SubmitSignatureParams {
  quoteToken: string;
  signature: `0x${string}`;
  approvalSignature?: `0x${string}`;
}

/** POST /v1/recover: `statusRef` alone starts; then a "sign" answer's `authorization` with the
 * paying wallet's `signature`; then a "done" answer's `authorization` alone, to look for more. */
export interface RecoverParams {
  /** The Hinkal swap's statusRef from execute (its order id). */
  statusRef: string;
  authorization?: string;
  signature?: `0x${string}`;
}

/**
 * What a failed Hinkal swap left at Hinkal (never refunded on its own) comes back only on the paying
 * wallet's signatures, to that wallet, on the swap's source chain. "sign" step 1: a read-only session
 * message to personal_sign (the same for any statusRef); step 2: the recovery to sign
 * (eth_signTypedData_v4). "done": sent, amounts before Hinkal's recovery fee; its `authorization`
 * alone looks again. "nothing": nothing stuck that may be taken (yet: a failed payout's refund shows
 * a few minutes after it), or no such swap. recoverStuckFunds runs all of it, each step checked first.
 */
export type RecoverDTO = Schemas["RecoverDTO"];

export interface SubmitTransactionParams {
  /** The quoteToken execute() returned with that transaction, not the quote's own. */
  quoteToken: string;
  /** `transaction.serialized` after your user's wallet signed it, base64. */
  signedTransaction: string;
}

export interface ErrorMeta extends Schema<"Meta"> {}

/** Every `code` the API sends (see the API's Errors page), plus NETWORK_ERROR: no response came
 * back at all (offline, DNS, CORS, a dropped connection). New codes can appear: compare against
 * these, don't switch on them exhaustively. */
export type RavnErrorCode = Schemas["ErrorCode"] | "NETWORK_ERROR";

/**
 * Thrown by RavnClient.execute (and so executeAndTrack) before anything reaches the wallet, when
 * what RAVN returned could move more than the user asked to swap, or touch anything else: an
 * unknown contract, an approval beyond the amount, a fee above 1% or to anyone but RAVN, another
 * token, a signature of a kind it doesn't know. Nothing was sent or signed. Don't retry it blindly:
 * re-quote, and if it persists, tell RAVN.
 */
export class UnsafeExecutionError extends Error {
  readonly code = "UNSAFE_EXECUTION";
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "UnsafeExecutionError";
  }
}

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
