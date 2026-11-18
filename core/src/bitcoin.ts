/**
 * @ravnexchange/sdk/bitcoin: executeAndTrack's `sendBitcoinPsbt` for the wallets most Bitcoin users
 * hold, signing the PSBT RAVN builds (a bc1q… sender's deposit and RAVN's fee). No dependencies:
 * pass the wallet's own API in.
 */
import { SentUnclearError } from "./execute-and-track";
import type { ExecuteAndTrackHandlers } from "./execute-and-track";
import { psbtInputsOf } from "./guard-bitcoin";

/** sats-connect's `request` (Xverse, and the wallets sats-connect reaches). */
export type SatsConnectRequest = (
  method: "signPsbt",
  params: { psbt: string; signInputs: Record<string, number[]>; broadcast: boolean }
) => Promise<{ status: "success"; result: { psbt: string; txid?: string } } | { status: "error"; error: { code: number; message: string } }>;

/** A Unisat-style provider: `window.unisat`, OKX's `window.okxwallet.bitcoin`, Bitget's `window.bitkeep.unisat`. */
export interface UnisatLike {
  signPsbt(psbtHex: string, options: { autoFinalized: boolean; toSignInputs: { index: number; address: string }[] }): Promise<string>;
  pushPsbt(psbtHex: string): Promise<string>;
}

// sats-connect errors that come before anything is signed: a bad request, an unknown method, the
// user's refusal, no access. Anything else may come after the wallet broadcast it.
const NOT_SENT = new Set([-32700, -32600, -32601, -32602, -32000, -32002]);

const mayBeOut = () =>
  new SentUnclearError("The wallet signed the Bitcoin deposit but didn't say whether it broadcast it: it may still arrive. Check the wallet's activity before trying again.");

function toHex(b64: string): string {
  const bytes = typeof atob === "function" ? Array.from(atob(b64), (c) => c.charCodeAt(0)) : Array.from((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(b64, "base64"));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `sendBitcoinPsbt` through sats-connect: `request` from "sats-connect", `address` the paying
 * (bc1q…) address, the quote's userAddress. */
export function satsConnectHandlers(request: SatsConnectRequest, address: string): Pick<ExecuteAndTrackHandlers, "sendBitcoinPsbt"> {
  return {
    async sendBitcoinPsbt(psbt) {
      const res = await request("signPsbt", { psbt, signInputs: { [address]: psbtInputsOf(psbt, address) }, broadcast: true });
      if (res.status === "success" && res.result.txid) return res.result.txid;
      if (res.status === "error" && NOT_SENT.has(res.error.code)) throw new Error(`The wallet didn't sign the Bitcoin deposit, so nothing was sent: ${res.error.message}`);
      throw mayBeOut();
    },
  };
}

/** `sendBitcoinPsbt` through a Unisat-style provider: signs the PSBT (as hex), then broadcasts it. */
export function unisatHandlers(unisat: UnisatLike, address: string): Pick<ExecuteAndTrackHandlers, "sendBitcoinPsbt"> {
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
  };
}
