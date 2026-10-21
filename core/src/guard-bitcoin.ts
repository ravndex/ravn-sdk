import { UnsafeExecutionError } from "./types";
import type { DepositFeeDTO } from "./types";

/**
 * Checks a Bitcoin deposit's PSBT (BIP174, version 0, as RAVN builds it): its outputs pay exactly
 * `deposit.amount` to the deposit address, RAVN's fee (when there is one) to RAVN's fee wallet, and
 * everything else back to the sender, from the sender's own coins, at a network fee no wallet would
 * call absurd. Anything else leaving the wallet is refused.
 */
export function checkBitcoinPsbt(
  psbtBase64: string,
  ctx: { deposit: { address: string; amount: string }; fee?: DepositFeeDTO; userAddress: string; feeWallet?: string }
): void {
  const { inputs, outputs } = parsePsbt(psbtBase64);
  const depositScript = hex(outputScript(ctx.deposit.address));
  const userScript = hex(outputScript(ctx.userAddress));
  const feeScript = ctx.fee && ctx.feeWallet ? hex(outputScript(ctx.feeWallet)) : undefined;
  if (depositScript === userScript) fail("The deposit address is the sender's own");

  let deposited = 0n;
  let feePaid = 0n;
  let out = 0n;
  for (const o of outputs) {
    out += o.value;
    if (o.script === depositScript) deposited += o.value;
    else if (feeScript && o.script === feeScript) feePaid += o.value;
    else if (o.script !== userScript) fail("The Bitcoin transaction pays an address that is neither the deposit, RAVN's fee nor the sender");
  }
  if (deposited !== BigInt(ctx.deposit.amount)) fail("The Bitcoin transaction doesn't pay the deposit exactly its amount", { paid: deposited.toString() });
  if (ctx.fee && feePaid > BigInt(ctx.fee.amount)) fail("The Bitcoin transaction pays RAVN more than the fee", { paid: feePaid.toString() });

  let into = 0n;
  for (const i of inputs) {
    if (i.value === undefined || i.script === undefined) fail("A Bitcoin input doesn't say what it spends, so its network fee can't be checked");
    if (i.script !== userScript) fail("The Bitcoin transaction spends coins that aren't the sender's");
    into += i.value;
  }
  const networkFee = into - out;
  if (networkFee < 0n) fail("The Bitcoin transaction spends more than its inputs hold");
  // The smallest the transaction could be: inputs at taproot's 57.5 vB, outputs at 31 vB.
  const minVbytes = BigInt(Math.ceil(10 + inputs.length * 57.5 + outputs.length * 31));
  if (networkFee > minVbytes * MAX_SATS_PER_VBYTE) fail("The Bitcoin network fee is absurdly high", { networkFee: networkFee.toString() });
}

// Far above any rate the network has needed (RAVN builds at mempool.space's half-hour rate).
const MAX_SATS_PER_VBYTE = 1_000n;

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new UnsafeExecutionError(message, details);
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Uint8Array((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(b64, "base64"));
}

class Reader {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}
  get done() {
    return this.pos >= this.b.length;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.b.length) fail("The Bitcoin PSBT is cut short");
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u8 = () => this.bytes(1)[0];
  uint(n: number): bigint {
    const b = this.bytes(n);
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  }
  varint(): number {
    const first = this.u8();
    const v = first < 0xfd ? BigInt(first) : this.uint(first === 0xfd ? 2 : first === 0xfe ? 4 : 8);
    if (v > 1_000_000n) fail("The Bitcoin PSBT has an implausible length");
    return Number(v);
  }
}

interface Output {
  value: bigint;
  script: string;
}

function parseOutput(r: Reader): Output {
  const value = r.uint(8);
  return { value, script: hex(r.bytes(r.varint())) };
}

// A transaction in the legacy serialization (no witness), as PSBT v0 carries it unsigned.
function parseTx(r: Reader): { inputs: { txid: string; vout: number }[]; outputs: Output[] } {
  r.bytes(4);
  const inputs = Array.from({ length: r.varint() }, () => {
    const txid = hex(r.bytes(32));
    const vout = Number(r.uint(4));
    r.bytes(r.varint());
    r.bytes(4);
    return { txid, vout };
  });
  const outputs = Array.from({ length: r.varint() }, () => parseOutput(r));
  r.bytes(4);
  return { inputs, outputs };
}

// Key-value map: [keylen][key][valuelen][value]... up to a 0x00 separator.
function readMap(r: Reader): Map<number, Uint8Array> {
  const map = new Map<number, Uint8Array>();
  for (;;) {
    const keyLen = r.varint();
    if (keyLen === 0) return map;
    const key = r.bytes(keyLen);
    const value = r.bytes(r.varint());
    if (keyLen === 1) map.set(key[0], value);
  }
}

function parsePsbt(b64: string): { inputs: { value?: bigint; script?: string }[]; outputs: Output[] } {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    fail("The Bitcoin PSBT isn't base64");
  }
  const r = new Reader(bytes);
  if (hex(r.bytes(5)) !== "70736274ff") fail("The Bitcoin PSBT isn't a PSBT");
  const unsigned = readMap(r).get(0x00);
  if (!unsigned) fail("The Bitcoin PSBT carries no transaction (only version 0 is supported)");
  const tx = parseTx(new Reader(unsigned));
  const inputs = tx.inputs.map((prevout) => {
    const m = readMap(r);
    const witness = m.get(0x01);
    if (witness) {
      const o = parseOutput(new Reader(witness));
      return { value: o.value, script: o.script };
    }
    const full = m.get(0x00);
    if (full) {
      const prev = parseTx(new Reader(full));
      const o = prev.outputs[prevout.vout];
      return o ? { value: o.value, script: o.script } : {};
    }
    return {};
  });
  return { inputs, outputs: tx.outputs };
}

// ---- Addresses → output scripts (mainnet) --------------------------------------------------

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i];
  }
  return chk >>> 0;
}

function segwitScript(address: string): Uint8Array | undefined {
  const a = address.toLowerCase();
  if (address !== a && address !== address.toUpperCase()) return undefined;
  const sep = a.lastIndexOf("1");
  if (a.slice(0, sep) !== "bc" || a.length - sep < 7) return undefined;
  const data = Array.from(a.slice(sep + 1), (c) => BECH32.indexOf(c));
  if (data.some((d) => d < 0)) return undefined;
  const hrp = [..."bc"].map((c) => c.charCodeAt(0));
  const check = polymod([...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data]);
  const version = data[0];
  // BIP173 (bech32) for version 0, BIP350 (bech32m) above.
  if (check !== (version === 0 ? 1 : 0x2bc830a3)) return undefined;
  let acc = 0;
  let bits = 0;
  const program: number[] = [];
  for (const d of data.slice(1, -6)) {
    acc = ((acc << 5) | d) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      program.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) return undefined;
  if (version > 16 || program.length < 2 || program.length > 40 || (version === 0 && program.length !== 20 && program.length !== 32)) return undefined;
  return Uint8Array.from([version === 0 ? 0 : 0x50 + version, program.length, ...program]);
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Legacy P2PKH (1…) and P2SH (3…). The checksum isn't verified: the script is only compared with
// the transaction's own outputs, never sent anywhere.
function legacyScript(address: string): Uint8Array | undefined {
  let n = 0n;
  for (const c of address) {
    const d = BASE58.indexOf(c);
    if (d < 0) return undefined;
    n = n * 58n + BigInt(d);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of address) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  if (bytes.length !== 25) return undefined;
  const hash = bytes.slice(1, 21);
  if (bytes[0] === 0x00) return Uint8Array.from([0x76, 0xa9, 20, ...hash, 0x88, 0xac]);
  if (bytes[0] === 0x05) return Uint8Array.from([0xa9, 20, ...hash, 0x87]);
  return undefined;
}

function outputScript(address: string): Uint8Array {
  const script = segwitScript(address) ?? legacyScript(address);
  if (!script) fail("Not a Bitcoin mainnet address", { address });
  return script;
}
