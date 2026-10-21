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
}[];
const fixture = (name: string) => {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return structuredClone(f);
};

const RPC = "https://rpc.example";
const USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATTACKER = "8LjUgMjzZuHj8VdyxzkmLLQVmW4C3gd56md1nLd76TNW";

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
const inner = (f: ReturnType<typeof fixture>, ...instructions: Record<string, unknown>[]) => f.simulation.innerInstructions.push({ index: 0, instructions });

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
    const f = fixture("usdc->bonk jupiter");
    const wsol = f.simulation.preTokenBalances.find((b) => b.owner === USER && b.mint === "So11111111111111111111111111111111111111112");
    if (!wsol) return; // this route holds no wrapped SOL of the user's
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

  it("refuses an allowance a venue program leaves on the user's tokens, but not one it revokes", async () => {
    const approve = { programId: TOKEN, parsed: { type: "approve", info: { source: ATTACKER, delegate: ATTACKER, owner: USER, amount: "1" } } };
    const f = fixture("sol->usdc okx");
    inner(f, approve);
    await refuses(f, /leaves an allowance/);
    const revoked = fixture("sol->usdc okx");
    inner(revoked, approve, { programId: TOKEN, parsed: { type: "revoke", info: { source: ATTACKER, owner: USER } } });
    await expect(verify(revoked)).resolves.toBeUndefined();
    const checked = fixture("sol->usdc okx");
    inner(checked, { programId: TOKEN, parsed: { type: "approveChecked", info: { source: ATTACKER, delegate: ATTACKER, multisigOwner: USER, tokenAmount: {} } } });
    await refuses(checked, /leaves an allowance/);
  });

  it("refuses a change of authority over the user's tokens", async () => {
    const f = fixture("sol->usdc 0x_solana");
    inner(f, { programId: TOKEN, parsed: { type: "setAuthority", info: { account: ATTACKER, authorityType: "closeAccount", newAuthority: ATTACKER, authority: USER } } });
    await refuses(f, /changes an authority over the user's tokens/);
  });

  it("refuses handing the user's wallet to a program", async () => {
    const f = fixture("sol->usdc relay");
    inner(f, { programId: "11111111111111111111111111111111", parsed: { type: "assign", info: { account: USER, owner: ATTACKER } } });
    await refuses(f, /hands the user's wallet to a program/);
  });

  it("refuses a token or system call on the user's behalf the RPC couldn't read", async () => {
    const f = fixture("sol->base usdc mayan");
    inner(f, { programId: TOKEN, accounts: [ATTACKER, USER], data: "x" });
    await refuses(f, /token call on the user's behalf that can't be read/);
  });

  it("refuses the user's authority used on a stake account", async () => {
    const f = fixture("sol->usdc via ravn jupiter");
    inner(f, { programId: "Stake11111111111111111111111111111111111111", parsed: { type: "authorize", info: { stakeAccount: ATTACKER, authority: USER, newAuthority: ATTACKER } } });
    await refuses(f, /stake account or program/);
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
