import { UnsafeExecutionError } from "./types";
import { RAVN_FEE_WALLETS, SOLANA_PROGRAMS } from "./guard-contracts";

/**
 * Checks a Solana transaction RAVN returned (a swap, or a deposit with RAVN's fee inside it): every
 * program it calls is one RAVN's venues use, and what it visibly moves out of the user's wallet stays
 * within the swap: the input token up to the input amount (selling SOL: SOL and wrapped SOL together)
 * plus account rent, at most `feeCap` of it to RAVN, never another token, never an approval, a
 * change of owner or a durable nonce.
 *
 * Not read: what an instruction of a venue's own program (Jupiter, Relay, Mayan, 0x, OKX) moves. The
 * user signs for every token account they own, so such an instruction could move any of them; only
 * simulating the transaction shows what it does (checkSolanaSimulation). Those programs are allowed by name.
 */
export function checkSolanaTransaction(
  serialized: string,
  ctx: {
    inputToken: string;
    inputAmount: string;
    userAddress: string;
    /** The most RAVN may be paid: the stated fee, else 1% of the input. */
    feeCap: bigint;
    deposit?: { address: string; amount: string };
  }
): void {
  const msg = parseMessage(serialized);
  const user = ctx.userAddress;
  const amount = BigInt(ctx.inputAmount);
  const sellsSol = ctx.inputToken === WSOL_MINT;
  const feeWallet = RAVN_FEE_WALLETS.solana;
  if (!msg.signers.includes(user)) fail("The Solana transaction isn't signed by the user's wallet");
  // SOL the user sends to their own wrapped-SOL account isn't gone yet: it's counted when it leaves.
  // (An account loaded from a lookup table is undefined, so it's never one of these.)
  const known = (list: (string | undefined)[]) => new Set(list.filter((a): a is string => a !== undefined));
  const ownWsol = known(sellsSol ? [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((p) => associatedTokenAddress(user, WSOL_MINT, p)) : []);
  const ravn = known([feeWallet, ...[TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((p) => associatedTokenAddress(feeWallet, ctx.inputToken, p))]);

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
  let toRavn = 0n;
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
        const to = acct(1);
        if (acct(0) === user && !(to !== undefined && ownWsol.has(to))) {
          solOut += lamports;
          if (to !== undefined && ravn.has(to)) toRavn += lamports;
          if (strict) paidTo[payee(strict, acct(1), "SOL")] += lamports;
        }
      } else if (kind === 0 || kind === 3) {
        // CreateAccount / CreateAccountWithSeed: [funder, new account]; lamports after the seed.
        const lamports = kind === 0 ? u64(data, 4) : u64(data, 4 + 32 + 8 + Number(u64(data, 4 + 32)));
        if (acct(0) === user) solOut += lamports;
      } else if (kind === 1 || kind === 8 || kind === 9 || kind === 10) {
        // Assign / Allocate (with seed): never the user's own account.
        if (acct(0) === user) fail("The Solana transaction hands the user's account to a program");
      } else {
        // Durable nonces too (4): a signed transaction that never expires could be sent whenever.
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
        const dest = acct(kind === 3 ? 1 : 2);
        tokenOut += moved;
        if (dest !== undefined && ravn.has(dest)) toRavn += moved;
        if (strict) {
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

  // Selling SOL, SOL and wrapped SOL are the same funds: one budget.
  if (sellsSol) {
    if (solOut + tokenOut > amount + RENT_ALLOWANCE_LAMPORTS) fail("The Solana transaction sends more SOL than the swap and its account rent", { lamports: (solOut + tokenOut).toString() });
  } else {
    if (tokenOut > amount) fail("The Solana transaction moves more of the token than the swap's amount", { moved: tokenOut.toString() });
    if (solOut > RENT_ALLOWANCE_LAMPORTS) fail("The Solana transaction sends more SOL than its account rent", { lamports: solOut.toString() });
  }
  if (toRavn > ctx.feeCap) fail("The Solana transaction pays RAVN more than its fee", { paid: toRavn.toString() });
  if (msg.feePayer === user) {
    const priority = ((computeLimit ?? 1_400_000n) * computePrice) / 1_000_000n;
    if (priority > PRIORITY_FEE_CAP_LAMPORTS) fail("The Solana transaction's priority fee is absurdly high", { lamports: priority.toString() });
  }
  if (strict && ctx.deposit) {
    if (paidTo.deposit !== BigInt(ctx.deposit.amount)) fail("The Solana deposit doesn't pay the deposit exactly its amount", { paid: paidTo.deposit.toString() });
    if (paidTo.fee > ctx.feeCap) fail("The Solana deposit pays RAVN more than the fee", { paid: paidTo.fee.toString() });
  }
}

/**
 * Simulates a Solana transaction RAVN returned on your own RPC and refuses it unless what it would
 * take from the user stays within the swap. Running the venue programs checkSolanaTransaction can't
 * read, it sees every transfer they make, and counts each one out of the user's wallet or token
 * accounts in the order they happen: only the input token leaves, at most the input amount (plus
 * what came in earlier in the same transaction); SOL (wallet and wrapped) only account rent of at
 * most 0.02 SOL beside the network fee (selling SOL: plus the amount). None of the user's token
 * accounts changes hands, closes to someone else, or is left with an allowance; the user's authority
 * is used for no other token or system call, and none over a stake account, program or lookup table.
 * Refused too when the simulation fails or can't run, or the RPC's answer is incomplete: what the
 * transaction would move is then unknown.
 *
 * What it can't hold: the chain's state can change between this simulation and the transaction
 * landing, so an amount that depends on it (an exact-out swap's input) can differ; and assets that
 * aren't SOL or SPL tokens in the user's own accounts (a position in another program the user is the
 * authority of, a compressed NFT).
 */
export async function checkSolanaSimulation(
  serialized: string,
  ctx: { inputToken: string; inputAmount: string; userAddress: string },
  rpc: { url: string; fetch: typeof fetch }
): Promise<void> {
  const msg = parseMessage(serialized);
  const user = ctx.userAddress;
  const amount = BigInt(ctx.inputAmount);
  const sellsSol = ctx.inputToken === WSOL_MINT;
  if (!msg.signers.includes(user)) fail("The Solana transaction isn't signed by the user's wallet");
  const sim = await simulate(serialized, rpc);
  if (sim.err) fail("The Solana transaction fails in simulation, so what it would move can't be checked: get a fresh quote", { err: sim.err });

  // Every account in the message's order (static keys, then lookup-table ones): what balances count.
  const keys = [...msg.keys, ...(sim.loadedAddresses?.writable ?? []), ...(sim.loadedAddresses?.readonly ?? [])];
  if (sim.preBalances.length !== keys.length || sim.postBalances.length !== keys.length || !keys.every((k) => typeof k === "string")) {
    fail("Your Solana RPC's simulation doesn't give every account's balance, so what the transaction would move is unchecked");
  }
  for (const b of [...sim.preTokenBalances, ...sim.postTokenBalances]) {
    if (!Number.isInteger(b?.accountIndex) || b.accountIndex < 0 || b.accountIndex >= keys.length || typeof b.mint !== "string" || typeof b.owner !== "string") {
      fail("Your Solana RPC's simulation gives a token balance without its account, mint or owner, so what the transaction would move is unchecked");
    }
  }

  // Token accounts by address: mint and owner, as held before (or as opened, for a new one).
  const tokenAccount = new Map<string, { mint: string; owner: string }>();
  for (const b of [...sim.preTokenBalances, ...sim.postTokenBalances]) {
    if (!tokenAccount.has(keys[b.accountIndex])) tokenAccount.set(keys[b.accountIndex], { mint: b.mint, owner: b.owner });
  }
  const mine = (a: unknown) => typeof a === "string" && (a === user || tokenAccount.get(a)?.owner === user);
  // Wrapped SOL is SOL: one budget.
  const asset = (account: unknown) => {
    const mint = typeof account === "string" ? tokenAccount.get(account)?.mint : undefined;
    return mint === WSOL_MINT ? "SOL" : mint;
  };
  const input = sellsSol ? "SOL" : ctx.inputToken;
  const allowed = new Map<string, bigint>([
    [input, amount],
    ["SOL", (input === "SOL" ? amount : 0n) + RENT_ALLOWANCE_LAMPORTS],
  ]);
  const sent = new Map<string, bigint>();
  // One transfer, as it happens: out of the user's accounts it's held to what may leave; into them,
  // it may leave again later in the transaction (a route passing through the user's own account).
  const transfer = (from: unknown, to: unknown, what: string | undefined, n: bigint) => {
    if (mine(from) === mine(to)) return;
    if (what === undefined) fail("The Solana transaction, simulated, moves the user's tokens through an account the RPC doesn't describe");
    if (!mine(from)) {
      allowed.set(what, (allowed.get(what) ?? 0n) + n);
      return;
    }
    const total = (sent.get(what) ?? 0n) + n;
    sent.set(what, total);
    if (total <= (allowed.get(what) ?? 0n)) return;
    if (what === "SOL") fail(sellsSol ? "The Solana transaction, simulated, sends more SOL than the swap and its account rent" : "The Solana transaction, simulated, sends more SOL than its account rent", { lamports: total.toString() });
    if (what !== input) fail("The Solana transaction, simulated, moves a token other than the one being swapped", { mint: what, amount: total.toString() });
    fail("The Solana transaction, simulated, moves more of the token than the swap's amount", { amount: total.toString() });
  };
  const closes = (account: unknown, to: unknown) => {
    if (mine(account) && !mine(to)) fail("The Solana transaction, simulated, closes one of the user's token accounts to someone else");
  };
  // Allowances the user gives, by account: what the delegate may still move.
  const delegated = new Map<unknown, { delegate: unknown; left: bigint }>();

  const inner = new Map<number, { programId?: string; parsed?: unknown; accounts?: string[] }[]>();
  for (const group of sim.innerInstructions) {
    if (!Number.isInteger(group?.index) || !Array.isArray(group.instructions)) fail("Your Solana RPC's simulation gives inner instructions without their place, so what the transaction would move is unchecked");
    inner.set(group.index, group.instructions);
  }

  msg.instructions.forEach((ix, n) => {
    // The transaction's own system and token calls (checkSolanaTransaction allowed only these kinds).
    const at = (i: number) => keys[ix.indexes[i]];
    const kind = ix.program === SYSTEM_PROGRAM ? u32(ix.data, 0) : ix.data[0];
    if (ix.program === SYSTEM_PROGRAM && (kind === 0 || kind === 2)) transfer(at(0), at(1), "SOL", u64(ix.data, 4));
    else if (ix.program === SYSTEM_PROGRAM && kind === 3) transfer(at(0), at(1), "SOL", u64(ix.data, 4 + 32 + 8 + Number(u64(ix.data, 4 + 32))));
    else if ((ix.program === TOKEN_PROGRAM || ix.program === TOKEN_2022_PROGRAM) && (kind === 3 || kind === 12)) {
      transfer(at(0), at(kind === 3 ? 1 : 2), asset(at(0)) ?? asset(at(kind === 3 ? 1 : 2)), u64(ix.data, 1));
    } else if ((ix.program === TOKEN_PROGRAM || ix.program === TOKEN_2022_PROGRAM) && kind === 9) closes(at(0), at(1));

    // Then everything it called, in order.
    for (const call of inner.get(n) ?? []) {
      const parsed = isObject(call.parsed) ? call.parsed : undefined;
      const info = isObject(parsed?.info) ? parsed.info : {};
      const type = String(parsed?.type);
      const names = JSON.stringify(call).includes(user);
      if (call.programId === TOKEN_PROGRAM || call.programId === TOKEN_2022_PROGRAM) {
        const tokens = isObject(info.tokenAmount) ? info.tokenAmount.amount : info.amount;
        if (type === "transfer" || type === "transferChecked" || type === "transferCheckedWithFee") {
          transfer(info.source, info.destination, asset(info.source) ?? asset(info.destination), whole(tokens));
          const allowance = delegated.get(info.source);
          if (allowance && allowance.delegate === (info.authority ?? info.multisigAuthority)) {
            allowance.left -= whole(tokens);
            if (allowance.left <= 0n) delegated.delete(info.source);
          }
        } else if (type === "unwrapLamports") {
          // Wrapped SOL straight out as lamports; with no amount, all of it (unknown unless it stays the user's).
          transfer(info.source, info.destination, "SOL", info.amount === undefined && mine(info.destination) ? 0n : whole(info.amount));
        } else if (type === "closeAccount") closes(info.account, info.destination);
        else if ((type === "approve" || type === "approveChecked") && (info.owner ?? info.multisigOwner) === user) {
          delegated.set(info.source, { delegate: info.delegate, left: whole(tokens) });
        } else if (type === "revoke" && (info.owner ?? info.multisigOwner) === user) delegated.delete(info.source);
        else if (names && !TOKEN_CALLS_ALLOWED.has(type)) {
          fail("The Solana transaction, simulated, makes a token call with the user's authority that RAVN's swaps never make", { type: parsed ? type : "unreadable" });
        }
      } else if (call.programId === SYSTEM_PROGRAM) {
        if (type === "transfer") transfer(info.source, info.destination, "SOL", whole(info.lamports));
        else if (type === "createAccount" || type === "createAccountWithSeed") transfer(info.source, info.newAccount, "SOL", whole(info.lamports));
        else if (names) fail("The Solana transaction, simulated, makes a system call with the user's wallet that RAVN's swaps never make", { type: parsed ? type : "unreadable" });
      } else if (call.programId === ATA_PROGRAM || call.programId === MEMO_PROGRAM || call.programId === MEMO_V1_PROGRAM) {
        continue;
      } else if (names && (AUTHORITY_PROGRAMS.has(String(call.programId)) || call.parsed !== undefined)) {
        // Programs the RPC names (stake, vote, loaders, lookup tables): none of RAVN's swaps use the
        // user's authority there. A venue's own (unnamed) programs move funds only through the above.
        fail("The Solana transaction, simulated, uses the user's authority over a stake account, program or lookup table", { program: call.programId });
      }
    }
  });
  if (delegated.size) fail("The Solana transaction, simulated, leaves an allowance on one of the user's token accounts");

  // And the outcome, in case anything moved that the instructions don't show: no token account of the
  // user's in other hands, and what was lost overall within the same limits.
  const lamportsLost = (i: number) => whole(sim.preBalances[i]) - whole(sim.postBalances[i]);
  let solLost = lamportsLost(keys.indexOf(user)) - (msg.feePayer === user ? whole(sim.fee) : 0n);
  const tokenLost = new Map<string, bigint>();
  const count = (mint: string, n: bigint) => tokenLost.set(mint, (tokenLost.get(mint) ?? 0n) + n);
  const held = new Set<number>();
  for (const b of sim.preTokenBalances) {
    if (b.owner !== user) continue;
    held.add(b.accountIndex);
    // A token account's lamports are its rent, and on a wrapped-SOL account the SOL it wraps.
    solLost += lamportsLost(b.accountIndex);
    if (b.mint !== WSOL_MINT) count(b.mint, whole(b.uiTokenAmount?.amount));
  }
  for (const b of sim.postTokenBalances) {
    if (held.has(b.accountIndex) && b.owner !== user) fail("The Solana transaction, simulated, hands one of the user's token accounts to someone else", { mint: b.mint });
    if (b.owner === user && b.mint !== WSOL_MINT) count(b.mint, -whole(b.uiTokenAmount?.amount));
  }
  if (solLost > RENT_ALLOWANCE_LAMPORTS + (sellsSol ? amount : 0n)) {
    fail(sellsSol ? "The Solana transaction, simulated, takes more SOL than the swap and its account rent" : "The Solana transaction, simulated, takes more SOL than its account rent", {
      lamports: solLost.toString(),
    });
  }
  for (const [mint, lost] of tokenLost) {
    if (lost <= 0n) continue;
    if (mint !== ctx.inputToken) fail("The Solana transaction, simulated, moves a token other than the one being swapped", { mint, amount: lost.toString() });
    if (lost > amount) fail("The Solana transaction, simulated, moves more of the token than the swap's amount", { amount: lost.toString() });
  }
}

/** Token calls that may name the user besides transfers, closes and allowances (each held above). */
const TOKEN_CALLS_ALLOWED = new Set(["syncNative", "initializeAccount", "initializeAccount2", "initializeAccount3", "initializeImmutableOwner", "getAccountDataSize"]);
/** Native programs where the user's authority is worth something: stake, vote, the loaders, lookup tables. */
const AUTHORITY_PROGRAMS = new Set([
  "Stake11111111111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "AddressLookupTab1e1111111111111111111111111",
  "Config1111111111111111111111111111111111111",
]);

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount?: { amount?: string };
}

interface Simulation {
  err: unknown;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  innerInstructions: { index: number; instructions: { programId?: string; parsed?: unknown; accounts?: string[] }[] }[];
  loadedAddresses?: { writable?: string[]; readonly?: string[] };
}

const SIMULATION_TIMEOUT_MS = 10_000;

// One simulateTransaction call: balances before and after (Agave 2.3+) and inner instructions, at the
// latest confirmed state, with the blockhash replaced so a slightly old one still simulates. Through
// the client's own fetch, called unbound; bounded even if that fetch ignores the abort signal.
async function simulate(serialized: string, rpc: { url: string; fetch: typeof fetch }): Promise<Simulation> {
  const fetchImpl = rpc.fetch;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`no answer within ${SIMULATION_TIMEOUT_MS / 1000} s`));
    }, SIMULATION_TIMEOUT_MS);
  });
  let body: { result?: { value?: Simulation }; error?: { message?: string } };
  try {
    const request = fetchImpl(rpc.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: [serialized, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", innerInstructions: true }],
      }),
      signal: abort.signal,
    }).then((res) => res.json());
    body = await Promise.race([request, timeout]);
  } catch (e) {
    // Never the URL itself: an RPC key often rides in it.
    const error = (e instanceof Error ? e.message : String(e)).split(rpc.url).join("<solanaRpcUrl>");
    fail("Couldn't simulate the Solana transaction on your RPC, so what it would move is unchecked", { error });
  } finally {
    clearTimeout(timer);
  }
  const v = body?.result?.value;
  if (!v) fail("Your Solana RPC didn't simulate the transaction, so what it would move is unchecked", { error: body?.error?.message });
  if (![v.preBalances, v.postBalances, v.preTokenBalances, v.postTokenBalances, v.innerInstructions].every(Array.isArray) || v.fee === undefined) {
    fail("Your Solana RPC's simulation doesn't report balance changes (Agave 2.3+ does), so what the transaction would move is unchecked");
  }
  return v;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const whole = (v: unknown): bigint => {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d{1,30}$/.test(v)) return BigInt(v);
  fail("Your Solana RPC's simulation reports an amount that isn't a whole number", { value: v });
};

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
  /** The static account keys: the indexes simulation balances count from, before lookup-table ones. */
  keys: string[];
  signers: string[];
  /** `indexes`: each account's index among all the transaction's accounts, lookup-table ones included. */
  instructions: { program: string; accounts: (string | undefined)[]; indexes: number[]; data: Uint8Array }[];
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
    return { program, accounts: accounts.map((a) => keys[a]), indexes: accounts, data };
  });
  if (keys.length === 0 || numSigners === 0) fail("The Solana transaction has no signer");
  return { feePayer: keys[0], keys, signers: keys.slice(0, numSigners), instructions };
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
