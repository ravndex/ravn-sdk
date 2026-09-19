import { RavnApiError } from "./types";
import type {
  ChainDTO,
  ExecuteParams,
  ExecutionDTO,
  GetQuoteParams,
  QuoteDTO,
  StatusDTO,
  SubmitSignatureParams,
  TokenDTO,
} from "./types";

export interface RavnClientConfig {
  /** Self-serve or enterprise key. Omit for the anonymous tier (works immediately, lower rate limit). */
  apiKey?: string;
  /** Default: https://app.ravn.exchange/api/v1 */
  baseUrl?: string;
  /** Swap in your own fetch (e.g. for React Native, or a test double). Defaults to global fetch. */
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
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        ...init.headers,
      },
    });

    let body: Envelope<T>;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch {
      // A non-JSON body (an intermediary's HTML error page, an empty 204/502/504) must still
      // surface as the one error type this client promises, never a raw SyntaxError.
      throw new RavnApiError("INTERNAL", `HTTP ${res.status}: response was not valid JSON`, undefined, undefined);
    }

    if (!res.ok || body.error) {
      const err = body.error ?? { code: "INTERNAL", message: `HTTP ${res.status}` };
      throw new RavnApiError(err.code, err.message, err.details, body.meta);
    }

    return body.data as T;
  }

  /** POST /v1/quote: omitting destinationAddress/refundAddress returns a preview-only quote (see QuoteDTO.executable). */
  getQuote(params: GetQuoteParams): Promise<QuoteDTO> {
    return this.request<QuoteDTO>("/quote", { method: "POST", body: JSON.stringify(params) });
  }

  /** POST /v1/execute: branch on the returned executionType (TRANSACTION / SIGNATURE / DEPOSIT). */
  execute(params: ExecuteParams): Promise<ExecutionDTO> {
    return this.request<ExecutionDTO>("/execute", { method: "POST", body: JSON.stringify(params) });
  }

  /** POST /v1/submit-signature: for SIGNATURE-type executions only. Returns the ref to poll getStatus with. */
  submitSignature(params: SubmitSignatureParams): Promise<{ statusRef: string }> {
    return this.request<{ statusRef: string }>("/submit-signature", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /** GET /v1/status: `ref` is the DEPOSIT address or the statusRef from submitSignature. */
  getStatus(quoteToken: string, ref: string): Promise<StatusDTO> {
    const qs = new URLSearchParams({ quoteToken, ref }).toString();
    return this.request<StatusDTO>(`/status?${qs}`, { method: "GET" });
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
