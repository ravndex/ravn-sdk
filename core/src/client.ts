import { RavnApiError } from "./types";
import type {
  ChainDTO,
  ExecuteParams,
  ExecutionDTO,
  GetQuoteParams,
  QuoteDTO,
  QuoteStreamOptions,
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

function envelopeData<T>(body: Envelope<T>, ok: boolean, status?: number): T {
  if (!ok || body.error) {
    const err = body.error ?? { code: "INTERNAL", message: `HTTP ${status}` };
    throw new RavnApiError(err.code, err.message, err.details, body.meta, { status });
  }
  return body.data as T;
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

  private async send(path: string, init: RequestInit): Promise<Response> {
    // Called unbound, never as this.fetchImpl(...): a browser's own fetch (the default, or one
    // passed in) throws "Illegal invocation" when `this` is the client, failing every call.
    const fetchImpl = this.fetchImpl;
    try {
      return await fetchImpl(`${this.baseUrl}${path}`, {
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
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    return this.unwrap<T>(path, await this.send(path, init), init.signal);
  }

  private async unwrap<T>(path: string, res: Response, signal?: AbortSignal | null): Promise<T> {
    let body: Envelope<T>;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch (err) {
      if (signal?.aborted) throw err;
      // A non-JSON body (an intermediary's HTML error page, an empty 204/502/504) must still
      // surface as the one error type this client promises, never a raw SyntaxError.
      throw new RavnApiError("INTERNAL", `HTTP ${res.status}: response was not valid JSON`, undefined, undefined, { status: res.status });
    }

    return envelopeData(body, res.ok, res.status);
  }

  /** POST /v1/quote: omitting destinationAddress/refundAddress returns a preview-only quote (see QuoteDTO.executable). */
  getQuote(params: GetQuoteParams): Promise<QuoteDTO> {
    return this.request<QuoteDTO>("/quote", { method: "POST", body: JSON.stringify(params) });
  }

  /**
   * POST /v1/quote, streamed: the same QuoteDTO getQuote resolves to, while `onEvent` hears each
   * venue's prices as they land (the first usually within a second, while the race waits on its
   * slowest venue). For showing prices early; execute only the quote this resolves to. Falls back
   * to a single answer where the response isn't streamed (an API or proxy that predates it).
   */
  async getQuoteStream(params: GetQuoteParams, options: QuoteStreamOptions = {}): Promise<QuoteDTO> {
    const init = { method: "POST", body: JSON.stringify({ ...params, stream: true }), signal: options.signal };
    const res = await this.send("/quote", init);
    if (!res.ok || !(res.headers?.get?.("content-type") ?? "").includes("ndjson")) {
      return this.unwrap<QuoteDTO>("/quote", res, options.signal);
    }
    let done: (Envelope<QuoteDTO> & { status?: number }) | undefined;
    let garbled = false;
    const line = (text: string) => {
      if (!text.trim() || garbled) return;
      let event: { type: string } & Envelope<QuoteDTO> & { status?: number };
      try {
        event = JSON.parse(text);
      } catch {
        garbled = true;
        return;
      }
      if (event.type === "done") done = event;
      else if (event.type === "venues" || event.type === "settled") {
        try {
          options.onEvent?.(event as never);
        } catch {
          /* the caller's display, never the quote */
        }
      }
    };
    // A runtime without streamed bodies or TextDecoder (React Native) still gets every line, at the end.
    // node-fetch v2's body is a Node stream, with no getReader.
    const reader = typeof TextDecoder !== "undefined" && typeof res.body?.getReader === "function" ? res.body.getReader() : undefined;
    try {
      if (!reader) (await res.text()).split("\n").forEach(line);
      else {
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            line(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        }
        line(buf);
      }
    } catch (err) {
      reader?.cancel().catch(() => {});
      if (options.signal?.aborted) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new RavnApiError("NETWORK_ERROR", `Quote stream broke off: ${reason}`, undefined, undefined, { status: res.status, cause: err });
    }
    if (garbled) {
      // Not RAVN's stream (an intermediary's page): a server-side failure, as unwrap reads a non-JSON body.
      throw new RavnApiError("INTERNAL", `HTTP ${res.status}: quote stream was not valid JSON lines`, undefined, undefined, { status: res.status });
    }
    if (!done) {
      throw new RavnApiError("NETWORK_ERROR", "Quote stream ended before its answer", undefined, undefined, { status: res.status });
    }
    const status = done.status ?? res.status;
    return envelopeData(done, status >= 200 && status < 300, status);
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
