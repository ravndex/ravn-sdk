import {
  generateId,
  isTrustedBridgeMessage,
  makeEnvelope,
  warnOnVersionMismatch,
  BridgeEnvelope,
  BridgeInitPayload,
  SolanaWalletPushType,
  SolanaWalletState,
  WalletPushType,
  WalletState,
} from "./protocol";
import { handleWalletAction, handleSolanaAction, RavnWallet, RavnSolanaWallet } from "./wallet-dispatch";

export type { RavnWallet } from "./wallet-dispatch";
export type { RavnSolanaWallet } from "./wallet-dispatch";

export interface CreateRavnWidgetBridgeOptions {
  iframe: HTMLIFrameElement;
  /** The exact origin the widget is served from, e.g. "https://widget.ravn.exchange". Never "*". */
  widgetOrigin: string;
  /** Called on every wallet:* request from the widget. Return null while no EVM wallet is connected. */
  getWallet: () => RavnWallet | null;
  /** Called on every solana:* request. Independent of getWallet: return null while no Solana wallet is connected. */
  getSolanaWallet?: () => RavnSolanaWallet | null;
  /** Non-wallet config sent once at handshake: theme, allowed tokens, integrator API key, etc. */
  config?: Record<string, unknown>;
}

export interface RavnWidgetBridge {
  /** Call whenever the host's own EVM wallet state changes (connect, account switch, chain switch, disconnect). */
  updateWallet(wallet: Pick<WalletState, "address" | "chainId"> | null): void;
  /** Call whenever the host's own Solana wallet state changes. Independent of updateWallet. */
  updateSolanaWallet(wallet: Pick<SolanaWalletState, "address"> | null): void;
  /** Removes the message listener. Call on unmount. */
  destroy(): void;
}

/**
 * Host-side half of the widget postMessage bridge (see sdk/widget-connector/src/protocol.ts for
 * the wire format, and wallet-dispatch.ts for the actual per-action logic). Lets the embedded
 * iframe use whatever wallet is already connected on the host page instead of showing its own
 * connect flow: the widget only falls back to a self-contained connect UI if this bridge never
 * responds to its initial "bridge:ready" handshake.
 */
export function createRavnWidgetBridge(options: CreateRavnWidgetBridgeOptions): RavnWidgetBridge {
  const { iframe, widgetOrigin, getWallet, getSolanaWallet, config } = options;
  let lastWallet: WalletState | null = null;
  let lastSolanaWallet: SolanaWalletState | null = null;
  // Guards against the same action envelope being dispatched twice while the first dispatch is
  // still in flight (a duplicate postMessage delivery, or a buggy double-send from the widget);
  // signing/sending is not idempotent, so a duplicate must be dropped, not re-run.
  const inFlightActionIds = new Set<string>();

  function post(type: string, payload: unknown, id: string) {
    iframe.contentWindow?.postMessage(makeEnvelope(type, payload, id), widgetOrigin);
  }

  async function onMessage(event: MessageEvent) {
    if (event.origin === widgetOrigin && event.source === iframe.contentWindow) {
      warnOnVersionMismatch(event.data);
    }
    if (!isTrustedBridgeMessage(event, widgetOrigin, iframe.contentWindow)) return;

    const envelope = event.data as BridgeEnvelope;

    if (envelope.type === "bridge:ready") {
      const initPayload: BridgeInitPayload = {
        version: "1",
        wallet: lastWallet,
        solanaWallet: lastSolanaWallet,
        config,
      };
      post("bridge:init", initPayload, envelope.id);
      return;
    }

    if (envelope.type.startsWith("solana:") || envelope.type.startsWith("wallet:")) {
      if (inFlightActionIds.has(envelope.id)) return;
      inFlightActionIds.add(envelope.id);
      try {
        const reply = envelope.type.startsWith("solana:")
          ? await handleSolanaAction(envelope, getSolanaWallet?.() ?? null)
          : await handleWalletAction(envelope, getWallet());
        post(reply.type, reply.payload, reply.id);
      } finally {
        inFlightActionIds.delete(envelope.id);
      }
    }
  }

  window.addEventListener("message", onMessage);

  return {
    updateWallet(wallet) {
      // Checked on wallet?.address, not object truthiness: an integrator naively calling
      // updateWallet({ address: account.address ?? null, chainId: ... }) during a brief
      // reconnect/disconnect transition would otherwise pass a non-null OBJECT with a null
      // address, which read as "connected" under a plain `!wallet` check.
      const isConnected = !!wallet?.address;
      const previous = lastWallet;
      // Covers BOTH no-op directions: still connected to the same account+chain, and still
      // disconnected. The first version only checked the "still connected" half, so a host
      // calling updateWallet(null) repeatedly while already disconnected (e.g. from a re-running
      // effect) kept firing a fresh wallet:disconnected push on every call.
      const unchanged = isConnected
        ? previous !== null && previous.address === wallet!.address && previous.chainId === wallet!.chainId
        : previous === null;
      if (unchanged) return;
      lastWallet = isConnected ? { address: wallet!.address, chainId: wallet!.chainId } : null;

      const pushType: WalletPushType = !isConnected
        ? "wallet:disconnected"
        : !previous
          ? "wallet:connected"
          : previous.address !== wallet!.address
            ? "wallet:accountChanged"
            : "wallet:chainChanged";

      post(pushType, lastWallet, generateId()); // fire-and-forget push, no matching request id
    },
    updateSolanaWallet(wallet) {
      const isConnected = !!wallet?.address;
      const previous = lastSolanaWallet;
      const unchanged = isConnected
        ? previous !== null && previous.address === wallet!.address
        : previous === null;
      if (unchanged) return;
      lastSolanaWallet = isConnected ? { address: wallet!.address } : null;

      const pushType: SolanaWalletPushType = !isConnected
        ? "solana:disconnected"
        : !previous
          ? "solana:connected"
          : "solana:accountChanged";

      post(pushType, lastSolanaWallet, generateId());
    },
    destroy() {
      window.removeEventListener("message", onMessage);
    },
  };
}
