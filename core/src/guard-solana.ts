import { UnsafeExecutionError } from "./types";
import type { DepositFeeDTO } from "./types";
import { RAVN_FEE_WALLETS, SOLANA_PROGRAMS } from "./guard-contracts";

/**
 * Checks a Solana transaction RAVN returned (a swap, or a deposit with RAVN's fee inside it): every
 * program it calls is one RAVN's venues use, and what it visibly moves out of the user's wallet stays
 * within the swap: the input token up to the input amount, SOL up to the input amount (when selling
 * SOL) plus account rent, never another token, never an approval or a change of owner.
 *
 * Instructions of a venue's own program (Jupiter, Relay, Mayan, 0x) can move the user's funds in
 * ways only that program knows; they are allowed by program, not read.
 */
export function checkSolanaTransaction(
  serialized: string,
  ctx: {
    inputToken: string;
    inputAmount: string;
    userAddress: string;
    feeCap: bigint;
    fee?: DepositFeeDTO;
    deposit?: { address: string; amount: string };
  }
): void {
  const msg = parseMessage(serialized);
  const user = ctx.userAddress;
  const amount = BigInt(ctx.inputAmount);
  const sellsSol = ctx.inputToken === WSOL_MINT;
  const feeWallet = RAVN_FEE_WALLETS.solana;
  if (!msg.signers.includes(user)) fail("The Solana transaction isn't signed by the user's wallet");

  // A deposit RAVN built itself pays only the deposit and RAVN's fee: hold it to exactly that.
  const strict = ctx.deposit
    ? {
        owners: new Set([ctx.deposit.address, feeWallet, user]),
        payees: new Map<string, string>([
          [ctx.deposit.address, "deposit"],
          [feeWallet, "fee"],
        ]),
      }
    : undefined;

  let solOut = 0n;
  let tokenOut = 0n;
  let computeLimit: bigint | undefined;
  let computePrice = 0n;
  const paidTo: Record<string, bigint> = { deposit: 0n, fee: 0n };

  for (const ix of msg.instructions) {
    const program = ix.program;
    const data = ix.data;
    const acct = (i: number): string | undefined => ix.accounts[i];

    if (program === SYSTEM_PROGRAM) {
      const kind = u32(data, 0);
      if (kind === 2) {
        // Transfer { lamports }: [from, to]
        const lamports = u64(data, 4);
        if (acct(0) === user) {
          solOut += lamports;
          if (strict) paidTo[payee(strict, acct(1), "SOL")] += lamports;
        }
      } else if (kind === 0 || kind === 3) {
        // CreateAccount / CreateAccountWithSeed: [funder, new account]; lamports after the seed.
        const lamports = kind === 0 ? u64(data, 4) : u64(data, 4 + 32 + 8 + Number(u64(data, 4 + 32)));
        if (acct(0) === user) solOut += lamports;
      } else if (kind === 1 || kind === 8 || kind === 9 || kind === 10) {
        // Assign / Allocate (with seed): never the user's own account.
        if (acct(0) === user) fail("The Solana transaction hands the user's account to a program");
      } else if (kind !== 4) {
        fail("The Solana transaction makes a System call RAVN's swaps never make", { kind });
      }
      continue;
    }

    if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
      const kind = data[0];
      if (kind === 3 || kind === 12) {
        // Transfer { amount }: [source, destination, authority]
        // TransferChecked { amount, decimals }: [source, mint, destination, authority]
        const authority = acct(kind === 3 ? 2 : 3);
        if (authority !== user) continue;
        const source = acct(0);
        const mint = kind === 12 ? acct(1) : undefined;
        // A mint loaded from a lookup table is unknown: then the source must be the user's own
        // account for the input token (the token program refuses a mint that doesn't match it).
        const isInput =
          mint !== undefined ? mint === ctx.inputToken : source !== undefined && source === associatedTokenAddress(user, ctx.inputToken, program);
        if (!isInput) fail("The Solana transaction moves a token other than the one being swapped", { mint, source });
        const moved = u64(data, 1);
        tokenOut += moved;
        if (strict) {
          const dest = acct(kind === 3 ? 1 : 2);
          const owner = [...strict.payees.keys()].find((o) => dest !== undefined && dest === associatedTokenAddress(o, ctx.inputToken, program));
          paidTo[owner ? strict.payees.get(owner)! : payee(strict, undefined, "token")] += moved;
        }
      } else if (kind === 9) {
        // CloseAccount: [account, destination, owner]; the rent (and any wrapped SOL) back to the user.
        if (acct(2) === user && acct(1) !== user) fail("The Solana transaction closes the user's account to someone else");
      } else if (![1, 5, 16, 17, 18, 22].includes(kind)) {
        // Only: InitializeAccount(1/2/3), Revoke, SyncNative, InitializeImmutableOwner.
        fail("The Solana transaction makes a token call RAVN's swaps never make (an approval, a change of owner, a burn)", { kind });
      }
      continue;
    }

    if (program === ATA_PROGRAM) {
      // Create / CreateIdempotent: [payer, account, owner, mint, system, token program]
      if (data.length > 1 || (data.length === 1 && data[0] > 1)) fail("The Solana transaction makes an associated-account call RAVN's swaps never make");
      if (acct(0) === user) solOut += ATA_RENT_LAMPORTS;
      if (strict && !strict.owners.has(acct(2) ?? "")) fail("The Solana deposit opens a token account for someone other than the deposit, RAVN or the user");
      continue;
    }

    if (program === COMPUTE_BUDGET_PROGRAM) {
      if (data[0] === 2) computeLimit = BigInt(u32(data, 1));
      else if (data[0] === 3) computePrice = u64(data, 1);
      else if (data[0] !== 1 && data[0] !== 4) fail("The Solana transaction makes an unknown compute-budget call");
      continue;
    }

    if (program === MEMO_PROGRAM || program === MEMO_V1_PROGRAM) continue;

    if (strict) fail("The Solana deposit calls a program besides the token, system and memo programs", { program });
    if (!SOLANA_PROGRAMS.has(program)) fail("The Solana transaction calls a program RAVN doesn't route through", { program });
  }

  if (tokenOut > amount) fail("The Solana transaction moves more of the token than the swap's amount", { moved: tokenOut.toString() });
  const solBudget = (sellsSol ? amount : 0n) + RENT_ALLOWANCE_LAMPORTS;
  if (solOut > solBudget) fail("The Solana transaction sends more SOL than the swap and its account rent", { lamports: solOut.toString() });
  if (msg.feePayer === user) {
    const priority = ((computeLimit ?? 1_400_000n) * computePrice) / 1_000_000n;
    if (priority > PRIORITY_FEE_CAP_LAMPORTS) fail("The Solana transaction's priority fee is absurdly high", { lamports: priority.toString() });
  }
  if (strict && ctx.deposit) {
    if (paidTo.deposit !== BigInt(ctx.deposit.amount)) fail("The Solana deposit doesn't pay the deposit exactly its amount", { paid: paidTo.deposit.toString() });
    if (paidTo.fee > (ctx.fee ? BigInt(ctx.fee.amount) : 0n)) fail("The Solana deposit pays RAVN more than the fee", { paid: paidTo.fee.toString() });
  }
}

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MEMO_V1_PROGRAM = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
/** Rent of a token account (165 bytes), what opening one costs its payer. */
const ATA_RENT_LAMPORTS = 2_039_280n;
/** Account rent a swap may cost beside its amount: ~9 token accounts' worth. */
const RENT_ALLOWANCE_LAMPORTS = 20_000_000n;
/** 0.01 SOL: a hundred times what RAVN's venues set. */
const PRIORITY_FEE_CAP_LAMPORTS = 10_000_000n;

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new UnsafeExecutionError(message, details);
}

// Who a payment from the user went to, in a deposit RAVN built: the deposit or RAVN's fee wallet.
function payee(strict: { payees: Map<string, string> }, to: string | undefined, what: string): string {
  const p = to !== undefined ? strict.payees.get(to) : undefined;
  if (!p) fail(`The Solana deposit sends ${what} to someone other than the deposit or RAVN's fee`, { to });
  return p;
}

const u32 = (d: Uint8Array, at: number): number => {
  if (at + 4 > d.length) fail("A Solana instruction is cut short");
  return (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;
};
const u64 = (d: Uint8Array, at: number): bigint => {
  if (at + 8 > d.length) fail("A Solana instruction is cut short");
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]);
  return v;
};

// ---- Message ------------------------------------------------------------------------------

interface Message {
  feePayer: string;
  signers: string[];
  instructions: { program: string; accounts: (string | undefined)[]; data: Uint8Array }[];
}

/**
 * A wire transaction (legacy or v0). Accounts loaded from address lookup tables can't be named
 * without an RPC, so they read as undefined: a check that needs one fails closed. Programs and
 * signers can't come from a lookup table, so those are always known.
 */
function parseMessage(b64: string): Message {
  let b: Uint8Array;
  try {
    b = base64ToBytes(b64);
  } catch {
    fail("The Solana transaction isn't base64");
  }
  let i = 0;
  const need = (n: number) => {
    if (i + n > b.length) fail("The Solana transaction is cut short");
  };
  const compactU16 = (): number => {
    let v = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      need(1);
      const x = b[i++];
      v |= (x & 0x7f) << shift;
      if (!(x & 0x80)) return v;
    }
    fail("The Solana transaction has a malformed length");
  };
  const take = (n: number) => {
    need(n);
    const out = b.subarray(i, i + n);
    i += n;
    return out;
  };

  take(64 * compactU16());
  need(1);
  const versioned = (b[i] & 0x80) !== 0;
  if (versioned) {
    if ((b[i] & 0x7f) !== 0) fail("The Solana transaction is of a version this SDK can't read");
    i++;
  }
  const [numSigners] = take(3);
  const keys = Array.from({ length: compactU16() }, () => base58(take(32)));
  take(32);
  const raw = Array.from({ length: compactU16() }, () => {
    const [programIndex] = take(1);
    const accounts = Array.from(take(compactU16()));
    const data = take(compactU16());
    return { programIndex, accounts, data };
  });
  const instructions = raw.map(({ programIndex, accounts, data }) => {
    const program = keys[programIndex];
    if (program === undefined) fail("A Solana instruction calls a program from a lookup table");
    return { program, accounts: accounts.map((a) => keys[a]), data };
  });
  if (keys.length === 0 || numSigners === 0) fail("The Solana transaction has no signer");
  return { feePayer: keys[0], signers: keys.slice(0, numSigners), instructions };
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Uint8Array((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(b64, "base64"));
}

// ---- base58 -------------------------------------------------------------------------------

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const x of bytes) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of bytes) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

function base58Decode32(s: string): Uint8Array | undefined {
  let n = 0n;
  for (const c of s) {
    const d = ALPHABET.indexOf(c);
    if (d < 0) return undefined;
    n = n * 58n + BigInt(d);
  }
  const out = new Uint8Array(32);
  for (let k = 31; k >= 0; k--) {
    out[k] = Number(n & 0xffn);
    n >>= 8n;
  }
  return n === 0n ? out : undefined;
}

// ---- Associated token accounts (program-derived addresses) --------------------------------

const ataCache = new Map<string, string | undefined>();

/** The associated token account of `owner` for `mint` under `tokenProgram`, or undefined for a bad key. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string | undefined {
  const key = `${owner}:${mint}:${tokenProgram}`;
  if (ataCache.has(key)) return ataCache.get(key);
  const seeds = [owner, tokenProgram, mint].map(base58Decode32);
  const program = base58Decode32(ATA_PROGRAM)!;
  let found: string | undefined;
  if (seeds.every((s) => s)) {
    const marker = Uint8Array.from("ProgramDerivedAddress", (c) => c.charCodeAt(0));
    for (let bump = 255; bump >= 0 && !found; bump--) {
      const hash = sha256(concat(...(seeds as Uint8Array[]), Uint8Array.of(bump), program, marker));
      if (!onCurve(hash)) found = base58(hash);
    }
  }
  if (ataCache.size > 256) ataCache.clear();
  ataCache.set(key, found);
  return found;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const P = 2n ** 255n - 19n;
const D = (-121665n * modPow(121666n, P - 2n, P)) % P;

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n;
  let b = ((base % m) + m) % m;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
  }
  return r;
}

// Whether 32 bytes decode to a point on ed25519 (a PDA must not): y² − 1 = x²(d·y² + 1) has a
// solution for x exactly when (y² − 1)/(d·y² + 1) is a square mod p.
function onCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let k = 31; k >= 0; k--) y = (y << 8n) | BigInt(k === 31 ? bytes[k] & 0x7f : bytes[k]);
  y %= P;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const ratio = (u * modPow(v, P - 2n, P)) % P;
  return ratio === 0n || modPow(ratio, (P - 1n) / 2n, P) === 1n;
}

// ---- SHA-256 (FIPS 180-4), for program-derived addresses -----------------------------------

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(msg: Uint8Array): Uint8Array {
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = msg.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((x, k) => ov.setUint32(k * 4, x));
  return out;
}
