import { describe, expect, it, vi } from "vitest";
import { RavnClient } from "./client";
import { RavnApiError } from "./types";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("RavnClient", () => {
  it("calls a browser's fetch unbound (window.fetch throws Illegal invocation as a method)", async () => {
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", browserFetch);
    try {
      await expect(new RavnClient().getChains()).resolves.toEqual([]);
      await expect(new RavnClient({ guard: false, fetch: browserFetch }).getChains()).resolves.toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends x-api-key and unwraps `data` on success", async () => {
    const fetchImpl = fakeFetch(200, { data: { quoteToken: "abc" }, meta: { requestId: "r1", version: "v1" } });
    const client = new RavnClient({ guard: false, apiKey: "test-key", fetch: fetchImpl });

    const result = await client.execute({ quoteToken: "abc" });

    expect(result).toEqual({ quoteToken: "abc" });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://app.ravn.exchange/api/v1/execute");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
  });

  it("POSTs status as a JSON body, not a query string (a 2-hop quoteToken can 431 a GET)", async () => {
    const fetchImpl = fakeFetch(200, { data: { status: "success", venue: "relay" } });
    const client = new RavnClient({ guard: false, fetch: fetchImpl });

    await client.getStatus("tok", "0xref");

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://app.ravn.exchange/api/v1/status");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ quoteToken: "tok", ref: "0xref" });
  });

  it("sends txHash with status when given (a Rift fee payment or a 2-hop hop-1 tx)", async () => {
    const fetchImpl = fakeFetch(200, { data: { status: "success", venue: "rift" } });
    await new RavnClient({ guard: false, fetch: fetchImpl }).getStatus("tok", "order-id", "0xfee");
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ quoteToken: "tok", ref: "order-id", txHash: "0xfee" });
  });

  it("omits x-api-key when no key is configured (anonymous tier)", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new RavnClient({ guard: false, fetch: fetchImpl });

    await client.getQuote({
      inputChainId: 1,
      outputChainId: 8453,
      inputToken: "0x0",
      outputToken: "0x0",
      inputAmount: "1000",
      userAddress: "0xabc",
    });

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect("x-api-key" in (init.headers as Record<string, string>)).toBe(false);
  });

  it("throws RavnApiError with the API's code/message on an error envelope", async () => {
    const fetchImpl = fakeFetch(410, {
      error: { code: "QUOTE_EXPIRED", message: "quoteToken has expired" },
      meta: { requestId: "r2", version: "v1" },
    });
    const client = new RavnClient({ guard: false, fetch: fetchImpl });

    await expect(client.execute({ quoteToken: "stale" })).rejects.toMatchObject({
      code: "QUOTE_EXPIRED",
      message: "quoteToken has expired",
    });
  });

  it("is an instanceof RavnApiError so integrators can narrow with instanceof", async () => {
    const fetchImpl = fakeFetch(400, { error: { code: "INVALID_REQUEST", message: "bad" } });
    const client = new RavnClient({ guard: false, fetch: fetchImpl });

    try {
      await client.getStatus("q", "ref");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RavnApiError);
    }
  });

  it("wraps a non-JSON body (e.g. an intermediary's HTML error page) as RavnApiError, not a raw SyntaxError", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    })) as unknown as typeof fetch;
    const client = new RavnClient({ guard: false, fetch: fetchImpl });

    await expect(client.execute({ quoteToken: "x" })).rejects.toBeInstanceOf(RavnApiError);
  });

  it("getTokens sends chainId as a query param and unwraps the array", async () => {
    const fetchImpl = fakeFetch(200, { data: [{ symbol: "USDC" }] });
    const client = new RavnClient({ guard: false, fetch: fetchImpl });

    const tokens = await client.getTokens(8453);

    expect(tokens).toEqual([{ symbol: "USDC" }]);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://app.ravn.exchange/api/v1/tokens?chainId=8453");
  });

  it("getChains unwraps the array with no query params", async () => {
    const fetchImpl = fakeFetch(200, { data: [{ chainId: 1, name: "Ethereum" }] });
    const client = new RavnClient({ guard: false, fetch: fetchImpl });

    const chains = await client.getChains();

    expect(chains).toEqual([{ chainId: 1, name: "Ethereum" }]);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://app.ravn.exchange/api/v1/chains");
  });

  it("respects a custom baseUrl and strips a trailing slash", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new RavnClient({ guard: false, baseUrl: "http://localhost:3000/api/v1/", fetch: fetchImpl });

    await client.execute({ quoteToken: "x" });

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/v1/execute");
  });

  it("sends execute's idempotencyKey as the Idempotency-Key header, not in the body", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new RavnClient({ guard: false, apiKey: "rvn_live_x", fetch: fetchImpl });

    await client.execute({ quoteToken: "x", idempotencyKey: "swap-attempt-1" });

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers).toMatchObject({ "Idempotency-Key": "swap-attempt-1", "x-api-key": "rvn_live_x" });
    expect(JSON.parse(init.body)).toEqual({ quoteToken: "x" });
  });

  it("refuses an idempotencyKey RAVN would refuse, without sending anything", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new RavnClient({ guard: false, fetch: fetchImpl });

    for (const bad of ["a b", "a\nb", "ключ", "", "k".repeat(256)]) {
      await expect(client.execute({ quoteToken: "x", idempotencyKey: bad })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// Claim 4 (audit 2026-10-17): one typed error, with the HTTP status and when to retry.
describe("RavnClient errors", () => {
  it("a network failure is a RavnApiError (NETWORK_ERROR), never a raw fetch TypeError", async () => {
    const cause = new TypeError("fetch failed");
    const client = new RavnClient({ guard: false, fetch: vi.fn(async () => { throw cause; }) as unknown as typeof fetch });

    const err = await client.getChains().catch((e) => e);

    expect(err).toBeInstanceOf(RavnApiError);
    expect(err).toMatchObject({ code: "NETWORK_ERROR", status: undefined, cause });
  });

  it("carries the HTTP status and details.retryAfterSec", async () => {
    const limited = fakeFetch(429, { error: { code: "RATE_LIMITED", message: "slow down", details: { retryAfterSec: 7 } } });
    const notJson = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("<html>"); } })) as unknown as typeof fetch;

    const err = await new RavnClient({ guard: false, fetch: limited }).getStatus("t", "r").catch((e) => e);
    const gateway = await new RavnClient({ guard: false, fetch: notJson }).getStatus("t", "r").catch((e) => e);

    expect(err).toMatchObject({ code: "RATE_LIMITED", status: 429, retryAfterSec: 7 });
    expect(gateway).toMatchObject({ code: "INTERNAL", status: 502, retryAfterSec: undefined });
  });

  it("passes a signal to fetch and lets the caller's own abort through as is", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return { ok: true, status: 200, json: async () => ({ data: { status: "success", venue: "relay" } }) };
    }) as unknown as typeof fetch;

    const err = await new RavnClient({ guard: false, fetch: fetchImpl }).getStatus("t", "r", undefined, { signal: controller.signal }).catch((e) => e);

    expect(err).toBe(controller.signal.reason);
  });
});

describe("getQuote timeoutMs", () => {
  it("sends the race's time limit when given (ravn-mvp #418; older APIs ignore it)", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    await new RavnClient({ guard: false, fetch: fetchImpl }).getQuote({
      inputChainId: 1, outputChainId: 8453, inputToken: "0xa", outputToken: "0xb", inputAmount: "1", userAddress: "0xu", timeoutMs: 3_000,
    });
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body as string).timeoutMs).toBe(3_000);
  });
});
