import { RavnApiError } from "./types";
import type {
  ChainDTO,
  ExecuteParams,
  ExecutionDTO,
  GetQuoteParams,
  QuoteDTO,
  StatusDTO,
  SubmitSignatureParams,
  SubmitTransactionParams,
  TokenDTO,
} from "./types";

export interface RavnClientConfig {
  /** Self-serve or enterprise key. Omit for the anonymous tier (works immediately, lower rate limit). */
  apiKey?: string;
  /** Default: https://app.ravn.exchange/api/v1 */
  baseUrl?: string;
  /** Swap in your own fetch (e.g. for React Native, or a test double). Defaults to global fetch.
   * Called as a plain function (no `this`): pass fetch itself, or a plain or bound wrapper. */
  fetch?: typeof fetch;
}

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: { requestId: string; version: string };
}

// ravn.exchange is the marketing site (separate deployment, no /api/* routes at all); the
// actual app, including this API, is served from the app subdomain. A caller that omits
// baseUrl entirely was 404ing on every single call until this fix.
const DEFAULT_BASE_URL = "https://app.ravn.exchange/api/v1";

export class RavnClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: RavnClientConfig = {}) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    // Called unbound, never as this.fetchImpl(...): a browser's own fetch (the default, or one
    // passed in) throws "Illegal invocation" when `this` is the client, failing every call.
    const fetchImpl = this.fetchImpl;
    let res: Response;
    try {
      res = await fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      // The caller's own abort is theirs, as is; anything else is the one error type this client
      // promises, never a raw fetch TypeError.
      if (init.signal?.aborted) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new RavnApiError("NETWORK_ERROR", `No response from ${path}: ${reason}`, undefined, undefined, { cause: err });
    }

    let body: Envelope<T>;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch (err) {
      if (init.signal?.aborted) throw err;
      // A non-JSON body (an intermediary's HTML error page, an empty 204/502/504) must still
      // surface as the one error type this client promises, never a raw SyntaxError.
      throw new RavnApiError("INTERNAL", `HTTP ${res.status}: response was not valid JSON`, undefined, undefined, { status: res.status });
    }

    if (!res.ok || body.error) {
      const err = body.error ?? { code: "INTERNAL", message: `HTTP ${res.status}` };
      throw new RavnApiError(err.code, err.message, err.details, body.meta, { status: res.status });
    }

    return body.data as T;
  }

  /** POST /v1/quote: omitting destinationAddress/refundAddress returns a preview-only quote (see QuoteDTO.executable). */
  getQuote(params: GetQuoteParams): Promise<QuoteDTO> {
    return this.request<QuoteDTO>("/quote", { method: "POST", body: JSON.stringify(params) });
  }

  /** POST /v1/execute: branch on the returned executionType (TRANSACTION / SIGNATURE / DEPOSIT). */
  execute({ idempotencyKey, ...params }: ExecuteParams): Promise<ExecutionDTO> {
    // The API's own rule: anything else fetch refuses to send (a reported NETWORK_ERROR) or RAVN answers 400.
    if (idempotencyKey !== undefined && !/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) {
      return Promise.reject(
        new RavnApiError("INVALID_REQUEST", "idempotencyKey must be 1–255 printable ASCII characters, no spaces", undefined, undefined)
      );
    }
    return this.request<ExecutionDTO>("/execute", {
      method: "POST",
      body: JSON.stringify(params),
      ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /** POST /v1/submit-signature: for SIGNATURE-type executions only. Returns the ref to poll getStatus with. */
  submitSignature(params: SubmitSignatureParams): Promise<{ statusRef: string }> {
    return this.request<{ statusRef: string }>("/submit-signature", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /** POST /v1/submit-transaction: only for a TRANSACTION execution carrying `submit`
   * (broadcastViaRavn quotes). RAVN checks the signed transaction, then sends it; refused, nothing
   * is sent. Returns the Solana signature; poll getStatus with the execution's statusRef. */
  submitTransaction(params: SubmitTransactionParams): Promise<{ txHash: string }> {
    return this.request<{ txHash: string }>("/submit-transaction", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /** POST /v1/status: pass the quoteToken execute() returned (not the quote's own), and as `ref`
   * the execution's statusRef, submitSignature's statusRef, or the origin tx hash. POST, not GET:
   * a 2-hop quoteToken in a query string can exceed header limits and fail with 431. `txHash`:
   * a two-hop route's hop-1 transaction, or the fee payment a DEPOSIT's `fee.transaction` asked
   * for; it's how RAVN proves the fee your share is paid from. `signal` aborts the request. */
  getStatus(quoteToken: string, ref: string, txHash?: string, options: { signal?: AbortSignal } = {}): Promise<StatusDTO> {
    return this.request<StatusDTO>("/status", {
      method: "POST",
      body: JSON.stringify({ quoteToken, ref, ...(txHash ? { txHash } : {}) }),
      signal: options.signal,
    });
  }

  /** GET /v1/tokens: RAVN's listed token registry for one chain. Not a per-pair routability guarantee. */
  getTokens(chainId: number): Promise<TokenDTO[]> {
    const qs = new URLSearchParams({ chainId: String(chainId) }).toString();
    return this.request<TokenDTO[]>(`/tokens?${qs}`, { method: "GET" });
  }

  /** GET /v1/chains: every chain RAVN lists tokens for. Static; safe to cache client-side. */
  getChains(): Promise<ChainDTO[]> {
    return this.request<ChainDTO[]>("/chains", { method: "GET" });
  }
}
