/**
 * @ravnexchange/sdk/bitcoin: executeAndTrack's `sendBitcoinPsbt` and `signBitcoinPsbt` for the wallets
 * most Bitcoin users hold, signing the PSBTs RAVN builds for a bc1q… sender (a deposit and RAVN's fee;
 * Layerswap's memo payment, which RAVN sends). No dependencies: pass the wallet's own API in. Plain Node ESM (no bundler) imports "@ravnexchange/sdk/dist/bitcoin.js".
 */
import { SentUnclearError } from "./execute-and-track";
import type { ExecuteAndTrackHandlers } from "./execute-and-track";
import { psbtInputsOf } from "./guard-bitcoin";

/** sats-connect's `request` (Xverse, and the wallets sats-connect reaches). */
export type SatsConnectRequest = (
  method: "signPsbt",
  params: { psbt: string; signInputs: Record<string, number[]>; broadcast: boolean }
) => Promise<{ status: "success"; result: { psbt: string; txid?: string } } | { status: "error"; error: { code: number; message: string } }>;

/** Unisat's provider (`window.unisat`), or another wallet's with the same signPsbt and pushPsbt. */
export interface UnisatLike {
  signPsbt(psbtHex: string, options: { autoFinalized: boolean; toSignInputs: { index: number; address: string }[] }): Promise<string>;
  pushPsbt(psbtHex: string): Promise<string>;
}

// sats-connect errors that come before anything is signed: a bad request, an unknown method, the
// user's refusal, no access. Anything else may come after the wallet broadcast it.
const NOT_SENT = new Set([-32700, -32600, -32601, -32602, -32000, -32002]);

const mayBeOut = () =>
  new SentUnclearError("The wallet signed the Bitcoin deposit but didn't say whether it broadcast it: it may still arrive. Check the wallet's activity before trying again.");

const notSigned = (why: string) => new Error(`The wallet didn't sign the Bitcoin payment, so nothing was sent: ${why}`);

function toHex(b64: string): string {
  const bytes = typeof atob === "function" ? Array.from(atob(b64), (c) => c.charCodeAt(0)) : Array.from((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(b64, "base64"));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Browser only (Unisat's provider), so btoa is there.
function hexToBase64(hex: string): string {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw notSigned("it returned something other than a PSBT");
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

/** `sendBitcoinPsbt` and `signBitcoinPsbt` through sats-connect: `request` from "sats-connect",
 * `address` the paying (bc1q…) address, the quote's userAddress. */
export function satsConnectHandlers(request: SatsConnectRequest, address: string): Pick<ExecuteAndTrackHandlers, "sendBitcoinPsbt" | "signBitcoinPsbt"> {
  return {
    async sendBitcoinPsbt(psbt) {
      const res = await request("signPsbt", { psbt, signInputs: { [address]: psbtInputsOf(psbt, address) }, broadcast: true });
      if (res.status === "success" && res.result.txid) return res.result.txid;
      if (res.status === "error" && NOT_SENT.has(res.error.code)) throw new Error(`The wallet didn't sign the Bitcoin deposit, so nothing was sent: ${res.error.message}`);
      throw mayBeOut();
    },
    // Never broadcast: RAVN sends it, and only if it's exactly the transaction RAVN built.
    async signBitcoinPsbt(psbt) {
      const res = await request("signPsbt", { psbt, signInputs: { [address]: psbtInputsOf(psbt, address) }, broadcast: false });
      if (res.status === "error") throw notSigned(res.error.message);
      if (!res.result.psbt) throw notSigned("it returned no PSBT");
      return res.result.psbt;
    },
  };
}

/** `sendBitcoinPsbt` through Unisat's provider: signs the PSBT (as hex), then broadcasts it.
 * `signBitcoinPsbt`: signs it and returns it as base64, never broadcast (RAVN sends it). */
export function unisatHandlers(unisat: UnisatLike, address: string): Pick<ExecuteAndTrackHandlers, "sendBitcoinPsbt" | "signBitcoinPsbt"> {
  return {
    async sendBitcoinPsbt(psbt) {
      const toSignInputs = psbtInputsOf(psbt, address).map((index) => ({ index, address }));
      // A refusal here: nothing was signed.
      const signed = await unisat.signPsbt(toHex(psbt), { autoFinalized: true, toSignInputs });
      try {
        return await unisat.pushPsbt(signed);
      } catch {
        throw mayBeOut();
      }
    },
    async signBitcoinPsbt(psbt) {
      const toSignInputs = psbtInputsOf(psbt, address).map((index) => ({ index, address }));
      // Base64 back: RAVN reads an all-hex string as a signed transaction, not a PSBT.
      return hexToBase64(await unisat.signPsbt(toHex(psbt), { autoFinalized: true, toSignInputs }));
    },
  };
}
