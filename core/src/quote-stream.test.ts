import { describe, expect, it, vi } from "vitest";
import { RavnClient } from "./client";
import { RavnApiError, type QuoteStreamEvent } from "./types";

const enc = new TextEncoder();
/** A streamed /v1/quote answer, its lines split across chunks the way a network delivers them. */
function ndjsonFetch(lines: unknown[], { status = 200, chunk = 7 } = {}) {
  const text = lines.map((l) => JSON.stringify(l) + "\n").join("");
  return vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < text.length; i += chunk) c.enqueue(enc.encode(text.slice(i, i + chunk)));
        c.close();
      },
    });
    return new Response(body, { status, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  }) as unknown as typeof fetch;
}

const price = { venue: { id: "kyberswap", name: "KyberSwap" }, outputAmount: "100" };
const quote = { quoteToken: "rq_x.0", venue: { id: "kyberswap", name: "KyberSwap" }, alternatives: [] };
const params = { inputChainId: 1, outputChainId: 1, inputToken: "0xA", outputToken: "0xB", inputAmount: "1", userAddress: "0xU" };

describe("RavnClient.getQuoteStream", () => {
  it("reports each venue's prices as they land, then resolves to the quote getQuote returns", async () => {
    const fetchImpl = ndjsonFetch([
      { type: "venues", venueIds: ["kyberswap", "okx"] },
      { type: "settled", venueId: "kyberswap", quotes: [price] },
      { type: "settled", venueId: "okx", quotes: [] },
      { type: "done", status: 200, data: quote, meta: { requestId: "r1", version: "v1" } },
    ]);
    const events: QuoteStreamEvent[] = [];
    const result = await new RavnClient({ apiKey: "k", fetch: fetchImpl }).getQuoteStream(params, { onEvent: (e) => events.push(e) });
    expect(result).toEqual(quote);
    expect(events).toEqual([
      { type: "venues", venueIds: ["kyberswap", "okx"] },
      { type: "settled", venueId: "kyberswap", quotes: [price] },
      { type: "settled", venueId: "okx", quotes: [] },
    ]);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://app.ravn.exchange/api/v1/quote");
    expect(JSON.parse(init.body as string)).toEqual({ ...params, stream: true });
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("throws the race's failure from the last line as RavnApiError", async () => {
    const fetchImpl = ndjsonFetch([
      { type: "venues", venueIds: [] },
      { type: "done", status: 404, error: { code: "NO_LIQUIDITY", message: "none" }, meta: { requestId: "r2", version: "v1" } },
    ]);
    const err = await new RavnClient({ fetch: fetchImpl }).getQuoteStream(params).catch((e) => e);
    expect(err).toBeInstanceOf(RavnApiError);
    expect(err).toMatchObject({ code: "NO_LIQUIDITY", status: 404, meta: { requestId: "r2" } });
  });

  it("throws a stream that ends before its answer", async () => {
    const fetchImpl = ndjsonFetch([{ type: "venues", venueIds: ["okx"] }]);
    await expect(new RavnClient({ fetch: fetchImpl }).getQuoteStream(params)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("takes a plain JSON answer as is: a refusal before streaming, or an API that predates it", async () => {
    const refused = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow down", details: { retryAfterSec: 3 } } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch;
    await expect(new RavnClient({ fetch: refused }).getQuoteStream(params)).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 3 });
    const old = vi.fn(async () => new Response(JSON.stringify({ data: quote }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(new RavnClient({ fetch: old }).getQuoteStream(params)).resolves.toEqual(quote);
  });

  it("an onEvent that throws doesn't lose the quote", async () => {
    const fetchImpl = ndjsonFetch([
      { type: "settled", venueId: "kyberswap", quotes: [price] },
      { type: "done", status: 200, data: quote },
    ]);
    const result = await new RavnClient({ fetch: fetchImpl }).getQuoteStream(params, {
      onEvent: () => {
        throw new Error("UI bug");
      },
    });
    expect(result).toEqual(quote);
  });
});

describe("RavnClient.getQuoteStream, rough edges", () => {
  it("decodes a character split across two network chunks", async () => {
    const bytes = enc.encode(JSON.stringify({ type: "settled", venueId: "ü-venue", quotes: [] }) + "\n" + JSON.stringify({ type: "done", status: 200, data: quote }) + "\n");
    const cut = bytes.indexOf(0xc3) + 1; // inside "ü"
    const fetchImpl = vi.fn(async () =>
      new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); } }), {
        headers: { "content-type": "application/x-ndjson" },
      })
    ) as unknown as typeof fetch;
    const events: QuoteStreamEvent[] = [];
    await new RavnClient({ fetch: fetchImpl }).getQuoteStream(params, { onEvent: (e) => events.push(e) });
    expect(events).toEqual([{ type: "settled", venueId: "ü-venue", quotes: [] }]);
  });

  it("a garbled line (a proxy's HTML) is INTERNAL, not a network error", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>bad gateway</html>\n", { headers: { "content-type": "application/x-ndjson" } })) as unknown as typeof fetch;
    await expect(new RavnClient({ fetch: fetchImpl }).getQuoteStream(params)).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("a custom fetch whose response has no headers is taken as a plain answer, like getQuote", async () => {
    const bare = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: quote }) })) as unknown as typeof fetch;
    await expect(new RavnClient({ fetch: bare }).getQuoteStream(params)).resolves.toEqual(quote);
    const refused = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(new RavnClient({ fetch: refused }).getQuote(params)).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
