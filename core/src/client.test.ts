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
  it("sends x-api-key and unwraps `data` on success", async () => {
    const fetchImpl = fakeFetch(200, { data: { quoteToken: "abc" }, meta: { requestId: "r1", version: "v1" } });
    const client = new RavnClient({ apiKey: "test-key", fetch: fetchImpl });

    const result = await client.execute({ quoteToken: "abc" });

    expect(result).toEqual({ quoteToken: "abc" });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://app.ravn.exchange/api/v1/execute");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
  });

  it("omits x-api-key when no key is configured (anonymous tier)", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new RavnClient({ fetch: fetchImpl });

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
    const client = new RavnClient({ fetch: fetchImpl });

    await expect(client.execute({ quoteToken: "stale" })).rejects.toMatchObject({
      code: "QUOTE_EXPIRED",
      message: "quoteToken has expired",
    });
  });

  it("is an instanceof RavnApiError so integrators can narrow with instanceof", async () => {
    const fetchImpl = fakeFetch(400, { error: { code: "INVALID_REQUEST", message: "bad" } });
    const client = new RavnClient({ fetch: fetchImpl });

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
    const client = new RavnClient({ fetch: fetchImpl });

    await expect(client.execute({ quoteToken: "x" })).rejects.toBeInstanceOf(RavnApiError);
  });

  it("getTokens sends chainId as a query param and unwraps the array", async () => {
    const fetchImpl = fakeFetch(200, { data: [{ symbol: "USDC" }] });
    const client = new RavnClient({ fetch: fetchImpl });

    const tokens = await client.getTokens(8453);

    expect(tokens).toEqual([{ symbol: "USDC" }]);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://app.ravn.exchange/api/v1/tokens?chainId=8453");
  });

  it("getChains unwraps the array with no query params", async () => {
    const fetchImpl = fakeFetch(200, { data: [{ chainId: 1, name: "Ethereum" }] });
    const client = new RavnClient({ fetch: fetchImpl });

    const chains = await client.getChains();

    expect(chains).toEqual([{ chainId: 1, name: "Ethereum" }]);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://app.ravn.exchange/api/v1/chains");
  });

  it("respects a custom baseUrl and strips a trailing slash", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new RavnClient({ baseUrl: "http://localhost:3000/api/v1/", fetch: fetchImpl });

    await client.execute({ quoteToken: "x" });

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/v1/execute");
  });
});
