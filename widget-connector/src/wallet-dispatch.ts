import {
  BridgeEnvelope,
  isSolanaActionType,
  isWalletActionType,
  makeEnvelope,
  SendTransactionRequest,
  SignMessageRequest,
  SignTypedDataRequest,
  SolanaSignTransactionRequest,
  SwitchChainRequest,
  WalletActionType,
} from "./protocol";

/**
 * What the host must implement to back the bridge — one call per wallet:* action type.
 *
 * These methods are the host's own wallet-signing boundary, not RAVN's: implement them by
 * calling your existing wallet/signer (e.g. wagmi's sendTransaction against an injected
 * connector), which already shows its own user-facing confirmation before signing. Do not wire
 * these to an auto-signer with no confirmation step — the widget iframe relays whatever it's
 * asked to relay, so the host implementation is the only place a user gets to see what they're
 * approving.
 */
export interface RavnWallet {
  address: string | null;
  chainId: number | null;
  sendTransaction(req: SendTransactionRequest): Promise<{ txHash: string }>;
  signTypedData(req: SignTypedDataRequest): Promise<{ signature: `0x${string}` }>;
  signMessage(req: SignMessageRequest): Promise<{ signature: `0x${string}` }>;
  switchChain(req: SwitchChainRequest): Promise<{ ok: true }>;
}

/** Shape check only, not a checksum validation — the host's own wallet library does the real
 *  validation before signing. Deliberately not viem's isAddress: this package has zero runtime
 *  dependencies (see package.json), and pulling in a whole wallet library for one regex isn't
 *  worth an integrator's install size. */
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Rejects malformed payloads before they reach the host's wallet — the widget iframe is the
 *  only source of these, but it's still an arbitrary postMessage across an origin boundary. */
function validate(type: WalletActionType, payload: unknown): void {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`${type}: payload must be an object`);
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.chainId !== "number") throw new Error(`${type}: chainId must be a number`);
  if (type === "wallet:sendTransaction" && (typeof p.to !== "string" || !ADDRESS_RE.test(p.to))) {
    throw new Error(`${type}: "to" must be a 0x-prefixed 40-hex-char address`);
  }
}

/**
 * Given an inbound wallet:* action envelope, calls the matching RavnWallet method and returns
 * the reply envelope (same id, so the widget side can correlate it). Pulled out of the
 * window/postMessage wiring in bridge.ts so it's testable without a DOM: this is the part with
 * actual branching logic, the wiring around it is not.
 */
export async function handleWalletAction(
  envelope: BridgeEnvelope,
  wallet: RavnWallet | null
): Promise<BridgeEnvelope> {
  if (!isWalletActionType(envelope.type)) {
    return makeEnvelope(
      "bridge:error",
      { error: { code: "UNKNOWN_MESSAGE_TYPE", message: `Unrecognized message type: ${envelope.type}` } },
      envelope.id
    );
  }

  if (!wallet) {
    return makeEnvelope(
      "bridge:error",
      { error: { code: "WALLET_NOT_CONNECTED", message: "No wallet connected on the host page" } },
      envelope.id
    );
  }

  try {
    const result = await dispatch(envelope.type, envelope.payload, wallet);
    return makeEnvelope(`${envelope.type}:result`, result, envelope.id);
  } catch (err) {
    return makeEnvelope(
      "bridge:error",
      {
        error: {
          code: "WALLET_ACTION_FAILED",
          message: err instanceof Error ? err.message : "Wallet action failed",
        },
      },
      envelope.id
    );
  }
}

function dispatch(type: WalletActionType, payload: unknown, wallet: RavnWallet) {
  validate(type, payload);
  switch (type) {
    case "wallet:sendTransaction":
      return wallet.sendTransaction(payload as SendTransactionRequest);
    case "wallet:signTypedData":
      return wallet.signTypedData(payload as SignTypedDataRequest);
    case "wallet:signMessage":
      return wallet.signMessage(payload as SignMessageRequest);
    case "wallet:switchChain":
      return wallet.switchChain(payload as SwitchChainRequest);
    default: {
      // Exhaustiveness check: adding a 5th WalletActionType without a case here is now a
      // compile error, not a silently-ignored request that falls through to `undefined`.
      const unhandled: never = type;
      throw new Error(`Unhandled wallet action type: ${unhandled}`);
    }
  }
}

/** What the host must implement to back Solana signing — a separate, independent wallet from RavnWallet (EVM). */
export interface RavnSolanaWallet {
  address: string | null;
  signTransaction(req: SolanaSignTransactionRequest): Promise<{ signedTransaction: string }>;
}

/** Same shape/error-handling as handleWalletAction, for the one solana:* action type. */
export async function handleSolanaAction(
  envelope: BridgeEnvelope,
  wallet: RavnSolanaWallet | null
): Promise<BridgeEnvelope> {
  if (!isSolanaActionType(envelope.type)) {
    return makeEnvelope(
      "bridge:error",
      { error: { code: "UNKNOWN_MESSAGE_TYPE", message: `Unrecognized message type: ${envelope.type}` } },
      envelope.id
    );
  }

  if (!wallet) {
    return makeEnvelope(
      "bridge:error",
      { error: { code: "SOLANA_WALLET_NOT_CONNECTED", message: "No Solana wallet connected on the host page" } },
      envelope.id
    );
  }

  try {
    const result = await wallet.signTransaction(envelope.payload as SolanaSignTransactionRequest);
    return makeEnvelope(`${envelope.type}:result`, result, envelope.id);
  } catch (err) {
    return makeEnvelope(
      "bridge:error",
      {
        error: {
          code: "WALLET_ACTION_FAILED",
          message: err instanceof Error ? err.message : "Solana wallet action failed",
        },
      },
      envelope.id
    );
  }
}
