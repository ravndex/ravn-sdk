/**
 * Wire protocol for the parent-page <-> widget-iframe postMessage bridge.
 *
 * Every message carries this envelope so the bridge can tell its own traffic apart from
 * everything else postMessage carries on a page (browser extensions, analytics, other
 * widgets). `version` is the protocol version, not the package version: bumped only on a
 * breaking wire-format change, so an old widget and a new host (or vice versa) can still tell
 * they're mismatched instead of silently misparsing each other.
 */

export const BRIDGE_SOURCE = "ravn-bridge" as const;
export const BRIDGE_VERSION = "1" as const;

export interface BridgeEnvelope<T = unknown> {
  source: typeof BRIDGE_SOURCE;
  version: typeof BRIDGE_VERSION;
  id: string;
  type: string;
  payload: T;
}

export function isBridgeEnvelope(data: unknown): data is BridgeEnvelope {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.source === BRIDGE_SOURCE &&
    d.version === BRIDGE_VERSION &&
    typeof d.id === "string" &&
    typeof d.type === "string"
  );
}

export function makeEnvelope<T>(type: string, payload: T, id: string): BridgeEnvelope<T> {
  return { source: BRIDGE_SOURCE, version: BRIDGE_VERSION, id, type, payload };
}

/** crypto.randomUUID needs a secure context and isn't in every supported browser: this bridge
 *  ships into arbitrary integrator pages, so it always needs the fallback, not just "sometimes". */
export function generateId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

/** The one trust check both bridge halves need on every inbound postMessage: right origin, right
 *  window object (not just "some script at that origin"), and a well-formed, version-matched
 *  envelope. Shared so a future fix to it can't land on one side and drift from the other. */
export function isTrustedBridgeMessage(
  event: MessageEvent,
  expectedOrigin: string,
  expectedSource: unknown
): boolean {
  return event.origin === expectedOrigin && event.source === expectedSource && isBridgeEnvelope(event.data);
}

/**
 * Diagnostic only; never affects control flow. isBridgeEnvelope() rejects a version-mismatched
 * message identically to random page noise (a browser extension, an unrelated script), which
 * means a genuine version skew between the widget and a host's @ravnexchange/widget-connector otherwise
 * fails completely silently: bridge:ready never gets a bridge:init reply, and nothing anywhere
 * says why. Call this once a message has already passed the origin+source check, so the warning
 * only fires for a message that really is from the trusted counterpart.
 */
export function warnOnVersionMismatch(data: unknown): void {
  if (typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  if (d.source === BRIDGE_SOURCE && typeof d.version === "string" && d.version !== BRIDGE_VERSION) {
    console.warn(
      `[ravn-bridge] protocol version mismatch: expected "${BRIDGE_VERSION}", got "${d.version}"; message ignored. The widget and this page's @ravnexchange/widget-connector are on different versions.`
    );
  }
}

// ---- Handshake --------------------------------------------------------------

export interface BridgeInitPayload {
  version: typeof BRIDGE_VERSION;
  wallet: WalletState | null;
  /** Independent from `wallet` (EVM): a host can have either, both, or neither connected. */
  solanaWallet: SolanaWalletState | null;
  config?: Record<string, unknown>;
}

// ---- Parent -> widget state pushes (fire-and-forget) -------------------------

export interface WalletState {
  address: string | null;
  chainId: number | null;
}

export type WalletPushType =
  | "wallet:connected"
  | "wallet:accountChanged"
  | "wallet:chainChanged"
  | "wallet:disconnected";

// ---- Widget -> parent action requests (request/response) --------------------

export interface SendTransactionRequest {
  chainId: number;
  to: string;
  data?: string;
  value?: string;
}
export interface SendTransactionResult {
  txHash: string;
}

export interface SignTypedDataRequest {
  chainId: number;
  typedData: Record<string, unknown>;
}
export interface SignMessageRequest {
  chainId: number;
  message: string;
}
export interface SignResult {
  signature: `0x${string}`;
}

export interface SwitchChainRequest {
  chainId: number;
}
export interface SwitchChainResult {
  ok: true;
}

export type WalletActionType =
  | "wallet:sendTransaction"
  | "wallet:signTypedData"
  | "wallet:signMessage"
  | "wallet:switchChain";

export interface BridgeErrorPayload {
  error: { code: string; message: string };
}

export function isWalletActionType(type: string): type is WalletActionType {
  return (
    type === "wallet:sendTransaction" ||
    type === "wallet:signTypedData" ||
    type === "wallet:signMessage" ||
    type === "wallet:switchChain"
  );
}

// ---- Solana: a separate, independent lane from the EVM one above -----------
//
// A host can have an EVM wallet, a Solana wallet, both, or neither connected; they're pushed
// and requested through entirely separate message types rather than folded into WalletState, so
// one updating never implies anything about the other.

export interface SolanaWalletState {
  address: string | null;
}

export type SolanaWalletPushType = "solana:connected" | "solana:accountChanged" | "solana:disconnected";

/** Base64 of an UNSIGNED VersionedTransaction's serialize(): same encoding useSwap.ts already
 *  uses everywhere it hands a Solana tx to a venue's submit endpoint. */
export interface SolanaSignTransactionRequest {
  transaction: string;
}
/** Base64 of the SIGNED VersionedTransaction's serialize(). */
export interface SolanaSignTransactionResult {
  signedTransaction: string;
}

export type SolanaActionType = "solana:signTransaction";

export function isSolanaActionType(type: string): type is SolanaActionType {
  return type === "solana:signTransaction";
}
