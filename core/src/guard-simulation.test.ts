import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { RavnClient } from "./client";
import { verifyExecution } from "./guard";
import type { SwapIntent } from "./guard";
import { UnsafeExecutionError } from "./types";
import type { ExecutionDTO } from "./types";

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: { amount: string };
}
interface Simulation {
  err: unknown;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  innerInstructions: { index: number; instructions: Record<string, unknown>[] }[];
  loadedAddresses: { writable: string[]; readonly: string[] };
}

// Real Solana /v1/execute answers (2026-10-21) and what simulating each on a mainnet RPC (Agave 4.3)
// returned, logs dropped: Jupiter, Jupiter's order engine, OKX, 0x, Relay, Mayan.
const FIXTURES = JSON.parse(readFileSync(new URL("./guard-solana-sim.fixtures.json", import.meta.url), "utf8")) as {
  name: string;
  intent: SwapIntent;
  execution: ExecutionDTO;
  simulation: Simulation;
  /** The user's wallet among the transaction's accounts. */
  userIndex: number;
  /** The user's token accounts in the transaction, by mint. */
  userTokenAccounts: Record<string, string>;
}[];
const fixture = (name: string) => {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return structuredClone(f);
};

const RPC = "https://rpc.example";
const USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const ATTACKER = "AttackerAttackerAttackerAttackerAttacker111";

const rpcAnswering = (body: unknown) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const simulated = (value: unknown) => rpcAnswering({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } });
const verify = (f: ReturnType<typeof fixture>, fetchImpl: typeof fetch = simulated(f.simulation)) => verifyExecution(f.execution, f.intent, { solanaRpcUrl: RPC }, fetchImpl);
const refuses = async (f: ReturnType<typeof fixture>, message: RegExp) => {
  const err = await verify(f).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UnsafeExecutionError);
  expect((err as Error).message).toMatch(message);
};
const userBalance = (s: Simulation, mint: string) => s.postTokenBalances.find((b) => b.owner === USER && b.mint === mint)!;
// Adds calls as if top-level instruction `index` made them (after any it already made).
const innerAt = (f: ReturnType<typeof fixture>, index: number, ...instructions: Record<string, unknown>[]) => {
  const group = f.simulation.innerInstructions.find((g) => g.index === index);
  if (group) group.instructions.push(...instructions);
  else f.simulation.innerInstructions.push({ index, instructions });
};
const inner = (f: ReturnType<typeof fixture>, ...instructions: Record<string, unknown>[]) => innerAt(f, 0, ...instructions);
const tokenTransfer = (source: string, destination: string, amount: bigint, authority = USER) => ({ programId: TOKEN, parsed: { type: "transfer", info: { source, destination, amount: amount.toString(), authority } } });

describe("verifyExecution simulates Solana transactions on the integrator's RPC", () => {
  it.each(FIXTURES.map((f) => f.name))("passes RAVN's real %s transaction", async (name) => {
    const f = fixture(name);
    const fetchImpl = simulated(f.simulation);
    await expect(verify(f, fetchImpl)).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RPC);
    const body = JSON.parse(String(init.body));
    expect(body.method).toBe("simulateTransaction");
    expect(body.params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true });
  });

  it("refuses a swap that takes another of the user's tokens", async () => {
    const f = fixture("sol->usdc jupiter");
    const pre = f.simulation.preTokenBalances.find((b) => b.owner === USER && b.mint === USDC)!;
    userBalance(f.simulation, USDC).uiTokenAmount.amount = (BigInt(pre.uiTokenAmount.amount) - 1n).toString();
    await refuses(f, /moves a token other than the one being swapped/);
  });

  it("refuses a swap that takes more of the input token than the amount", async () => {
    const f = fixture("usdc->bonk jupiter");
    const b = userBalance(f.simulation, USDC);
    b.uiTokenAmount.amount = (BigInt(b.uiTokenAmount.amount) - 1n).toString();
    await refuses(f, /more of the token than the swap's amount/);
  });

  it("refuses a SOL sell that takes more SOL than the amount and rent", async () => {
    const f = fixture("sol->usdc relay");
    f.simulation.postBalances[f.userIndex] -= 20_000_100; // a whale: past 2^53, JSON numbers are off by a few lamports
    await refuses(f, /more SOL than the swap and its account rent/);
  });

  it("refuses a token swap that takes SOL beyond rent", async () => {
    const f = fixture("usdc->bonk 0x_solana");
    f.simulation.postBalances[f.userIndex] -= 20_000_100; // a whale: past 2^53, JSON numbers are off by a few lamports
    await refuses(f, /more SOL than its account rent/);
  });

  it("counts wrapped SOL leaving the user's wrapped-SOL account as SOL", async () => {
    const f = fixture("usdc->bonk 0x_solana");
    const wsol = f.simulation.preTokenBalances.find((b) => b.owner === USER && b.mint === WSOL)!;
    expect(wsol).toBeDefined();
    f.simulation.postBalances[wsol.accountIndex] = 0;
    f.simulation.postTokenBalances = f.simulation.postTokenBalances.filter((b) => b.accountIndex !== wsol.accountIndex);
    f.simulation.preBalances[wsol.accountIndex] += 1_000_000_000;
    await refuses(f, /more SOL than its account rent/);
  });

  it("refuses a swap that hands one of the user's token accounts to someone else", async () => {
    const f = fixture("sol->usdc jupiter");
    userBalance(f.simulation, USDC).owner = ATTACKER;
    await refuses(f, /hands one of the user's token accounts to someone else/);
  });

  it("counts every transfer out of the user's accounts, not just the net: a refund leg can't hide a drain", async () => {
    // All 1,095 USDC out to a pool and 995 back: the net is the swap's 100, but on chain the pool's
    // side can be made to pay nothing.
    const f = fixture("usdc->bonk jupiter");
    const usdc = f.userTokenAccounts[USDC];
    inner(f, tokenTransfer(usdc, ATTACKER, 1_095_000_000n), tokenTransfer(ATTACKER, usdc, 995_000_000n, ATTACKER));
    await refuses(f, /more of the token than the swap's amount/);
  });

  it("never lets a later instruction spend what an earlier one paid in: a pool can pay less on chain", async () => {
    // Step 0 pays 995 USDC into the user's account (a pool's payout: on chain it can be nothing);
    // step 1 sends 995 out at a fixed amount, which would then come out of the user's own USDC.
    const f = fixture("sol->usdc jupiter");
    const usdc = f.userTokenAccounts[USDC];
    innerAt(f, 0, tokenTransfer(ATTACKER, usdc, 995_000_000n, ATTACKER));
    innerAt(f, 1, tokenTransfer(usdc, ATTACKER, 995_000_000n));
    await refuses(f, /moves a token other than the one being swapped/);
  });

  it("refuses inner instructions the RPC places nowhere or twice", async () => {
    const twice = fixture("usdc->bonk jupiter");
    twice.simulation.innerInstructions.push({ index: twice.simulation.innerInstructions[0].index, instructions: [] });
    await refuses(twice, /inner instructions without their place/);
    const nowhere = fixture("usdc->bonk jupiter");
    nowhere.simulation.innerInstructions.push({ index: 99, instructions: [] });
    await refuses(nowhere, /inner instructions without their place/);
  });

  it("refuses a transfer the RPC doesn't name both sides of", async () => {
    const f = fixture("usdc->bonk jupiter");
    inner(f, { programId: TOKEN, parsed: { type: "transfer", info: { source: f.userTokenAccounts[USDC], amount: "1", authority: USER } } });
    await refuses(f, /doesn't name both sides of/);
  });

  it("counts a burn out of the user's account as leaving", async () => {
    const input = fixture("usdc->bonk jupiter");
    const usdc = input.userTokenAccounts[USDC];
    inner(input, { programId: TOKEN, parsed: { type: "burn", info: { account: usdc, mint: USDC, amount: "1", authority: USER } } });
    await refuses(input, /more of the token than the swap's amount/);
    const other = fixture("usdc->bonk jupiter");
    inner(other, { programId: TOKEN, parsed: { type: "burnChecked", info: { account: other.userTokenAccounts[BONK], mint: BONK, tokenAmount: { amount: "1" }, authority: USER } } });
    await refuses(other, /moves a token other than the one being swapped/);
  });

  it("refuses an unreadable token call on one of the user's token accounts, even without the wallet", async () => {
    const f = fixture("usdc->bonk jupiter");
    inner(f, { programId: TOKEN, accounts: [f.userTokenAccounts[USDC], ATTACKER, ATTACKER], data: "x" });
    await refuses(f, /token call on the user's accounts/);
  });

  it("lets a token pass through the user's own account, but not leave before it arrived", async () => {
    const through = fixture("usdc->bonk jupiter");
    const bonk = through.userTokenAccounts[BONK];
    inner(through, tokenTransfer(ATTACKER, bonk, 5n, ATTACKER), tokenTransfer(bonk, ATTACKER, 5n));
    await expect(verify(through)).resolves.toBeUndefined();
    const early = fixture("usdc->bonk jupiter");
    inner(early, tokenTransfer(bonk, ATTACKER, 5n), tokenTransfer(ATTACKER, bonk, 5n, ATTACKER));
    await refuses(early, /moves a token other than the one being swapped/);
  });

  it("counts wrapped SOL unwrapped straight to someone else as SOL leaving", async () => {
    const f = fixture("usdc->sol relay");
    inner(f, { programId: TOKEN, parsed: { type: "unwrapLamports", info: { source: f.userTokenAccounts[WSOL], destination: ATTACKER, authority: USER, amount: "1000000000" } } });
    await refuses(f, /sends more SOL than its account rent/);
  });

  it("refuses closing the user's token account to someone else", async () => {
    const f = fixture("usdc->bonk 0x_solana");
    inner(f, { programId: TOKEN, parsed: { type: "closeAccount", info: { account: f.userTokenAccounts[WSOL], destination: ATTACKER, owner: USER } } });
    await refuses(f, /closes one of the user's token accounts to someone else/);
  });

  it("refuses an allowance a venue program leaves on the user's tokens, but not one it revokes or uses up", async () => {
    const f0 = fixture("sol->usdc okx");
    const usdc = f0.userTokenAccounts[USDC];
    const approve = { programId: TOKEN, parsed: { type: "approve", info: { source: usdc, delegate: ATTACKER, owner: USER, amount: "1" } } };
    inner(f0, approve);
    await refuses(f0, /leaves an allowance/);
    const revoked = fixture("sol->usdc okx");
    inner(revoked, approve, { programId: TOKEN, parsed: { type: "revoke", info: { source: usdc, owner: USER } } });
    await expect(verify(revoked)).resolves.toBeUndefined();
    const used = fixture("sol->usdc okx");
    inner(used, approve, tokenTransfer(ATTACKER, usdc, 1n, ATTACKER), tokenTransfer(usdc, ATTACKER, 1n, ATTACKER));
    await expect(verify(used)).resolves.toBeUndefined();
    const checked = fixture("sol->usdc okx");
    inner(checked, { programId: TOKEN, parsed: { type: "approveChecked", info: { source: usdc, delegate: ATTACKER, multisigOwner: USER, tokenAmount: { amount: "1" } } } });
    await refuses(checked, /leaves an allowance/);
  });

  it.each([
    ["a change of authority", { type: "setAuthority", info: { account: ATTACKER, authorityType: "closeAccount", newAuthority: ATTACKER, authority: USER } }],
    ["minting with the user's mint authority", { type: "mintTo", info: { mint: ATTACKER, account: ATTACKER, mintAuthority: USER, amount: "1" } }],
    ["withdrawing fees the user may withdraw", { type: "withdrawWithheldTokensFromMint", info: { mint: ATTACKER, feeRecipient: ATTACKER, withdrawWithheldAuthority: USER } }],
  ])("refuses %s", async (_, parsed) => {
    const f = fixture("sol->usdc 0x_solana");
    inner(f, { programId: TOKEN, parsed });
    await refuses(f, /token call on the user's accounts that RAVN's swaps never make/);
  });

  it.each([
    ["handing the user's wallet to a program", { type: "assign", info: { account: USER, owner: ATTACKER } }],
    ["emptying a nonce account the user controls", { type: "withdrawFromNonce", info: { nonceAccount: ATTACKER, destination: ATTACKER, nonceAuthority: USER, lamports: 1 } }],
    ["moving SOL from an account derived from the user's", { type: "transferWithSeed", info: { source: ATTACKER, sourceBase: USER, destination: ATTACKER, lamports: 1 } }],
  ])("refuses %s", async (_, parsed) => {
    const f = fixture("sol->usdc relay");
    inner(f, { programId: SYSTEM, parsed });
    await refuses(f, /system call with the user's wallet that RAVN's swaps never make/);
  });

  it("refuses a token or system call naming the user that the RPC couldn't read", async () => {
    const f = fixture("sol->base usdc mayan");
    inner(f, { programId: TOKEN, accounts: [ATTACKER, USER], data: "x" });
    await refuses(f, /token call on the user's accounts/);
    const g = fixture("sol->base usdc mayan");
    inner(g, { programId: SYSTEM, accounts: [USER, ATTACKER], data: "x" });
    await refuses(g, /system call with the user's wallet/);
  });

  it("refuses the user's authority used on a stake account, read or not", async () => {
    const f = fixture("sol->usdc via ravn jupiter");
    inner(f, { programId: "Stake11111111111111111111111111111111111111", parsed: { type: "authorize", info: { stakeAccount: ATTACKER, authority: USER, newAuthority: ATTACKER } } });
    await refuses(f, /stake account, program or lookup table/);
    const raw = fixture("sol->usdc via ravn jupiter");
    inner(raw, { programId: "Stake11111111111111111111111111111111111111", accounts: [ATTACKER, USER], data: "x" });
    await refuses(raw, /stake account, program or lookup table/);
  });

  it("refuses an incomplete answer instead of passing it", async () => {
    const noOwner = fixture("usdc->bonk jupiter");
    delete (noOwner.simulation.postTokenBalances[0] as Partial<TokenBalance>).owner;
    await refuses(noOwner, /token balance without its account, mint or owner/);
    const short = fixture("usdc->bonk jupiter");
    short.simulation.preBalances = [];
    short.simulation.postBalances = [];
    await refuses(short, /doesn't give every account's balance/);
    const noTables = fixture("usdc->bonk jupiter");
    noTables.simulation.loadedAddresses = { writable: [], readonly: [] };
    await refuses(noTables, /doesn't give every account's balance/);
  });

  it("refuses a transaction that fails in simulation: what it moves is unknown", async () => {
    const f = fixture("sol->usdc jupiter");
    f.simulation.err = { InstructionError: [3, { Custom: 6001 }] };
    await refuses(f, /fails in simulation/);
  });

  it("refuses when the RPC can't simulate or doesn't report balance changes", async () => {
    const f = fixture("sol->usdc jupiter");
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(verify(f, down)).rejects.toThrow(/Couldn't simulate the Solana transaction on your RPC/);
    await expect(verify(f, rpcAnswering({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limited" } }))).rejects.toThrow(/didn't simulate/);
    const old = { ...f.simulation } as Partial<Simulation>;
    delete old.preTokenBalances;
    await expect(verify(f, simulated(old))).rejects.toThrow(/doesn't report balance changes/);
  });

  it("gives up after 10 s even when the fetch ignores the abort, and never repeats the RPC's URL", async () => {
    const f = fixture("sol->usdc jupiter");
    vi.useFakeTimers();
    try {
      const hanging = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
      const pending = verify(f, hanging).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(String(await pending)).toMatch(/Couldn't simulate .* on your RPC/);
    } finally {
      vi.useRealTimers();
    }
    // As given, and as node-fetch writes it (a slash before the query).
    const keyed = "https://rpc.example?api-key=SECRETKEY";
    const leaky = vi.fn(async () => {
      throw new Error(`request to ${keyed} or https://rpc.example/?api-key=SECRETKEY failed`);
    }) as unknown as typeof fetch;
    const err = (await verifyExecution(f.execution, f.intent, { solanaRpcUrl: keyed }, leaky).catch((e: unknown) => e)) as UnsafeExecutionError;
    expect(err).toBeInstanceOf(UnsafeExecutionError);
    expect(JSON.stringify(err.details)).not.toContain("SECRETKEY");
  });

  it("catches what reading the transaction can't: a Jupiter route selling more than the swap", async () => {
    // Jupiter's own instruction moves the wrapped SOL; read alone, this passes for a 1-lamport swap.
    const f = fixture("sol->usdc jupiter");
    f.intent.inputAmount = "1";
    await refuses(f, /more SOL than the swap and its account rent/);
  });

  it("still runs the structural check first: a transaction it refuses never reaches the RPC", async () => {
    const f = fixture("sol->usdc jupiter");
    const fetchImpl = simulated(f.simulation);
    await expect(verifyExecution(f.execution, { ...f.intent, inputToken: USDC }, { solanaRpcUrl: RPC }, fetchImpl)).rejects.toThrow(UnsafeExecutionError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("simulates nothing without solanaRpcUrl", async () => {
    const f = fixture("sol->usdc jupiter");
    const fetchImpl = simulated(f.simulation);
    await expect(verifyExecution(f.execution, f.intent, {}, fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("RavnClient.execute simulates with guard.solanaRpcUrl", () => {
  const client = (f: ReturnType<typeof fixture>, simulation: Simulation) => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === RPC) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { value: simulation } }) };
      const path = new URL(url).pathname.split("/").pop()!;
      const data = path === "quote" ? { quoteToken: "q1", alternatives: [] } : f.execution;
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ data }) };
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    return { fetchImpl, ravn: new RavnClient({ fetch: fetchImpl, guard: { solanaRpcUrl: RPC } }) };
  };

  it("hands back a transaction whose simulation stays within the swap", async () => {
    const f = fixture("sol->usdc okx");
    const { fetchImpl, ravn } = client(f, f.simulation);
    await ravn.getQuote({ ...f.intent, outputChainId: -2, outputToken: USDC });
    await expect(ravn.execute({ quoteToken: "q1" })).resolves.toEqual(f.execution);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toContain(RPC);
  });

  it("refuses one whose simulation takes more", async () => {
    const f = fixture("sol->usdc okx");
    const tampered = structuredClone(f.simulation);
    userBalance(tampered, USDC).owner = ATTACKER;
    const { ravn } = client(f, tampered);
    await ravn.getQuote({ ...f.intent, outputChainId: -2, outputToken: USDC });
    await expect(ravn.execute({ quoteToken: "q1" })).rejects.toThrow(UnsafeExecutionError);
  });
});
