import { describe, expect, it, vi } from "vitest";
import { createRavnWidgetBridge, RavnWallet } from "./bridge";
import { BridgeConfigPayload, BridgeEnvelope, BridgeInitPayload, isBridgeEnvelope, makeEnvelope } from "./protocol";

const WIDGET_ORIGIN = "https://widget.ravn.exchange";

function fakeIframe() {
  let handler: ((event: MessageEvent) => void) | null = null;
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];

  vi.stubGlobal("window", {
    addEventListener: (_type: string, h: (event: MessageEvent) => void) => {
      handler = h;
    },
    removeEventListener: () => {
      handler = null;
    },
  });

  const iframe = {
    contentWindow: { postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin }) },
  } as unknown as HTMLIFrameElement;

  return {
    iframe,
    posted,
    simulate: (data: unknown, source: unknown = iframe.contentWindow, origin = WIDGET_ORIGIN) =>
      handler?.({ origin, data, source } as MessageEvent),
  };
}

function fakeWallet(overrides: Partial<RavnWallet> = {}): RavnWallet {
  return {
    address: "0xabc",
    chainId: 1,
    sendTransaction: vi.fn(async () => ({ txHash: "0xhash" })),
    signTypedData: vi.fn(async () => ({ signature: "0xsig" as const })),
    signMessage: vi.fn(async () => ({ signature: "0xsig" as const })),
    switchChain: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

describe("createRavnWidgetBridge", () => {
  it("ignores messages from the wrong origin or the wrong source window", () => {
    const { iframe, simulate } = fakeIframe();
    const getWallet = vi.fn(() => fakeWallet());
    createRavnWidgetBridge({ iframe, widgetOrigin: WIDGET_ORIGIN, getWallet });

    simulate(makeEnvelope("bridge:ready", {}, "r1"), iframe.contentWindow, "https://attacker.example");
    simulate(makeEnvelope("bridge:ready", {}, "r2"), {});

    expect(getWallet).not.toHaveBeenCalled();
  });

  it("updateWallet() does not post when nothing actually changed", () => {
    const { iframe, posted } = fakeIframe();
    const bridge = createRavnWidgetBridge({ iframe, widgetOrigin: WIDGET_ORIGIN, getWallet: () => null });

    bridge.updateWallet({ address: "0xabc", chainId: 1 });
    expect(posted).toHaveLength(1); // wallet:connected

    bridge.updateWallet({ address: "0xabc", chainId: 1 }); // identical, redundant call
    expect(posted).toHaveLength(1); // still just the one push, no spurious chainChanged
  });

  it("updateWallet(null) does not repost wallet:disconnected while already disconnected", () => {
    const { iframe, posted } = fakeIframe();
    const bridge = createRavnWidgetBridge({ iframe, widgetOrigin: WIDGET_ORIGIN, getWallet: () => null });

    bridge.updateWallet(null); // starts disconnected: this itself is a no-op, nothing to announce
    expect(posted).toHaveLength(0);

    bridge.updateWallet({ address: "0xabc", chainId: 1 });
    bridge.updateWallet(null);
    expect(posted).toHaveLength(2); // connected, then disconnected

    bridge.updateWallet(null); // redundant: a host re-running an effect while still disconnected
    bridge.updateWallet(null);
    expect(posted).toHaveLength(2); // no additional spurious disconnect pushes
  });

  it("updateWallet() still posts accountChanged/chainChanged when something actually changes", () => {
    const { iframe, posted } = fakeIframe();
    const bridge = createRavnWidgetBridge({ iframe, widgetOrigin: WIDGET_ORIGIN, getWallet: () => null });

    bridge.updateWallet({ address: "0xabc", chainId: 1 });
    bridge.updateWallet({ address: "0xabc", chainId: 8453 });
    expect(posted[1].message).toMatchObject({ type: "wallet:chainChanged" });

    bridge.updateWallet({ address: "0xdef", chainId: 8453 });
    expect(posted[2].message).toMatchObject({ type: "wallet:accountChanged" });
  });

  it("does not dispatch the same in-flight action id twice", async () => {
    const { iframe, simulate, posted } = fakeIframe();
    let resolveSend!: (v: { txHash: string }) => void;
    const wallet = fakeWallet({
      sendTransaction: vi.fn(() => new Promise<{ txHash: string }>((resolve) => (resolveSend = resolve))),
    });
    createRavnWidgetBridge({ iframe, widgetOrigin: WIDGET_ORIGIN, getWallet: () => wallet });

    const envelope = makeEnvelope(
      "wallet:sendTransaction",
      { chainId: 1, to: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" },
      "same-id"
    );
    const first = simulate(envelope); // not yet awaited, still in flight
    const second = simulate(envelope); // duplicate delivery of the identical request

    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
    resolveSend({ txHash: "0xhash" });
    await Promise.all([first, second]);
    expect(posted).toHaveLength(1);
  });

  it("updateConfig() posts a bridge:config envelope to the widget's origin", () => {
    const { iframe, posted } = fakeIframe();
    const bridge = createRavnWidgetBridge({ iframe, widgetOrigin: WIDGET_ORIGIN, getWallet: () => null });

    bridge.updateConfig({ appearance: "light", primaryColor: "#D46F06" });

    expect(posted).toHaveLength(1);
    expect(posted[0].targetOrigin).toBe(WIDGET_ORIGIN);
    const message = posted[0].message as BridgeEnvelope<BridgeConfigPayload>;
    expect(isBridgeEnvelope(message)).toBe(true);
    expect(message.type).toBe("bridge:config");
    expect(message.payload).toEqual({ config: { appearance: "light", primaryColor: "#D46F06" } });
  });

  it("a later bridge:ready gets the updated config, keeping the apiKey and pair a theme update left out", () => {
    const { iframe, posted, simulate } = fakeIframe();
    // A plain Record<string, unknown> still fits both config slots (npm run typecheck covers this file).
    const initial: Record<string, unknown> = { apiKey: "key", sellChain: "ethereum", light: { background: "#FFFFFF" } };
    const bridge = createRavnWidgetBridge({ iframe, widgetOrigin: WIDGET_ORIGIN, getWallet: () => null, config: initial });

    bridge.updateConfig({ appearance: "light", light: { primaryColor: "#000000" } });
    simulate(makeEnvelope("bridge:ready", {}, "r1"));

    const merged = { apiKey: "key", sellChain: "ethereum", appearance: "light", light: { primaryColor: "#000000" } };
    expect((posted[0].message as BridgeEnvelope<BridgeConfigPayload>).payload.config).toEqual(merged);
    const init = posted[1].message as BridgeEnvelope<BridgeInitPayload>;
    expect(init.type).toBe("bridge:init");
    expect(init.id).toBe("r1");
    expect(init.payload.config).toEqual(merged);
    expect(initial).toEqual({ apiKey: "key", sellChain: "ethereum", light: { background: "#FFFFFF" } }); // not mutated

    // Type-level only, never called: known fields are still checked.
    void (() => {
      bridge.updateConfig(initial);
      // @ts-expect-error appearance is "dark" | "light" | "auto"
      bridge.updateConfig({ appearance: "dim" });
    });
  });
});
