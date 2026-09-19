/**
 * Wire types for RAVN's public /api/v1 surface. Deliberately a standalone mirror of
 * src/lib/api/v1/dto.ts's public DTOs, not an import from it — this package ships to npm on
 * its own and can't depend on the app's internal source tree. Keep these two in sync by hand
 * when the API's public contract changes; that file's own comment already promises the shape
 * is frozen for third parties, so drift should be rare.
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
  /** Opaque handle — pass back to execute() verbatim. Do not parse. */
  quoteToken: string;
  venue: { id: string; name: string };
  routeType: string;
  input: { token: TokenDTO; amount: string };
  output: { token: TokenDTO; amount: string };
  /** `supported: false` means the venue has no fee mechanism at all (bps will be 0 either
   * way) — distinct from `supported: true, bps: 0`, a real, intentional zero fee. */
  fee: { bps: number; amount: string; token: TokenDTO; supported: boolean };
  /** False means this is a preview-only price — see RavnClient.getQuote's destinationAddress note. */
  executable: boolean;
  slippage: { bps: number; isFirm: boolean; guaranteedMin: string | null } | null;
  gas: { native: string; nativeSymbol: string; usd: string | null; estimated: boolean } | null;
  /** Same price source as `gas.usd`. Null when the token can't be priced. */
  inputUsd: string | null;
  outputUsd: string | null;
  estimatedTimeSeconds: number;
  estimatedTimeIsGuess: boolean;
  expiresAt: number;
  /** Every other venue that raced and produced a usable quote, best output first. */
  alternatives: AlternativeQuoteDTO[];
}

export interface AlternativeQuoteDTO {
  venue: { id: string; name: string };
  routeType: string;
  /** Pass to execute() to run THIS route instead of the primary quote. */
  quoteToken: string;
  outputAmount: string;
  fee: { bps: number; amount: string; supported: boolean };
  executable: boolean;
  estimatedTimeSeconds: number;
  estimatedTimeIsGuess: boolean;
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
}

export type ExecutionDTO =
  | {
      executionType: "TRANSACTION";
      approval?: ApprovalDTO;
      transaction: {
        to?: string;
        data?: string;
        value?: string;
        chainId?: number;
        serialized?: string;
      };
    }
  | {
      executionType: "SIGNATURE";
      approval?: ApprovalDTO;
      typedData?: Record<string, unknown>;
      approvalData?: Record<string, unknown>;
      submit: { url: string; payload?: Record<string, unknown> };
    }
  | {
      executionType: "DEPOSIT";
      deposit: { address: string; amount: string; chainId?: number };
      statusRef: string;
    };

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

export interface GetQuoteParams {
  inputChainId: number;
  outputChainId: number;
  inputToken: string;
  outputToken: string;
  /** Positive integer string, in the token's smallest unit (no decimals). */
  inputAmount: string;
  userAddress: string;
  /** Omitting this yields a preview-only quote — see QuoteDTO.executable. */
  destinationAddress?: string;
  refundAddress?: string;
  slippageBps?: number;
  rankingMode?: "best_output" | "fastest";
  /** Drop specific venues from this race — e.g. a risk objection to one of them. */
  excludeVenues?: string[];
  /** Test quote -> execute -> status with no real funds and no live venue settlement. See
   * the API's own sandbox field description for per-venue/per-route exceptions. */
  sandbox?: boolean;
}

export interface ExecuteParams {
  quoteToken: string;
  destinationAddress?: string;
  refundAddress?: string;
}

export interface SubmitSignatureParams {
  quoteToken: string;
  signature: `0x${string}`;
  approvalSignature?: `0x${string}`;
}

export interface ErrorMeta {
  requestId: string;
  version: string;
}

/** Thrown for every non-2xx response. `code` is the stable, machine-readable string from the API. */
export class RavnApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: unknown,
    public readonly meta: ErrorMeta | undefined
  ) {
    super(message);
    this.name = "RavnApiError";
  }
}
