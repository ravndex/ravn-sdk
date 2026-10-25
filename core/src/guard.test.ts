import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { RavnClient } from "./client";
import { checkExecution } from "./guard";
import { KNOWN_CONTRACTS } from "./guard-contracts";
import type { SwapIntent } from "./guard";
import { associatedTokenAddress, sha256 } from "./guard-solana";
import { UnsafeExecutionError } from "./types";
import type { ExecutionDTO } from "./types";

// Real /v1/execute answers (2026-10-21), one per shape: every venue, execution type and chain kind
// RAVN hands out, with long swap calldata cut after its first words (nothing reads past them). Route's
// two (2026-10-25): Route's own builds in /v1/execute's shape, as Route isn't in RAVN's race yet.
const FIXTURES = JSON.parse(readFileSync(new URL("./guard.fixtures.json", import.meta.url), "utf8")) as {
  name: string;
  intent: SwapIntent;
  execution: ExecutionDTO;
}[];
const fixture = (name: string) => {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return structuredClone(f);
};

const ATTACKER = "0x000000000000000000000000000000000000dead";
const FEE_WALLET = "0x12d2425fd88c693edb4de004e0c747879b7d6933";
const word = (v: string | bigint) => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "").toLowerCase()).padStart(64, "0");
const approve = (spender: string, amount: bigint) => `0x095ea7b3${word(spender)}${word(amount)}`;
const transfer = (to: string, amount: bigint) => `0xa9059cbb${word(to)}${word(amount)}`;
const MAX = 2n ** 256n - 1n;

const refuses = (e: ExecutionDTO, intent: SwapIntent, message: RegExp) => {
  expect(() => checkExecution(e, intent)).toThrow(UnsafeExecutionError);
  expect(() => checkExecution(e, intent)).toThrow(message);
};

describe("checkExecution: what RAVN really returns", () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))("accepts %s", (_, f) => {
    expect(() => checkExecution(f.execution, f.intent)).not.toThrow();
  });
});

describe("checkExecution: EVM transactions", () => {
  const swap = () => fixture("8453 token->native relay");
  type Tx = Extract<ExecutionDTO, { executionType: "TRANSACTION" }>;

  it("refuses an approval to a spender RAVN doesn't route through", () => {
    const { execution, intent } = swap();
    const e = execution as Tx;
    e.approval!.data = approve(ATTACKER, 100_000_000n);
    e.calls![0].data = e.approval!.data;
    refuses(e, intent, /spender RAVN doesn't route through/);
  });

  it("refuses an approval beyond the swap's amount", () => {
    const { execution, intent } = swap();
    const e = execution as Tx;
    e.approval!.data = approve("0xccc88a9d1b4ed6b0eaba998850414b24f1c315be", MAX);
    e.calls![0].data = e.approval!.data;
    refuses(e, intent, /more than the swap's amount/);
  });

  it("accepts an unlimited approval only to a spender that needs the user's signature for each pull (CoW, Permit2)", () => {
    const { execution, intent } = fixture("8453 token->native cow");
    const e = execution as Extract<ExecutionDTO, { executionType: "SIGNATURE" }>;
    e.approval!.data = approve("0xC92E8bdf79f0507f65a392b0ab4667716BFE0110", MAX);
    e.approval!.amount = MAX.toString();
    expect(() => checkExecution(e, intent)).not.toThrow();
  });

  it("refuses an approval of another token", () => {
    const { execution, intent } = swap();
    const e = execution as Tx;
    e.approval!.to = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
    refuses(e, intent, /token other than the one being swapped/);
  });

  it("refuses a swap sent to an unknown contract, a token, RAVN's wallet or Permit2", () => {
    for (const to of [ATTACKER, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", FEE_WALLET, "0x000000000022D473030F116dDEE9F6B43aC78BA3"]) {
      const { execution, intent } = swap();
      const e = execution as Tx;
      e.transaction.to = to;
      refuses(e, intent, /contract RAVN doesn't route through/);
    }
  });

  it("refuses the native coin on a token sell, and more than the amount on a coin sell", () => {
    const token = swap();
    (token.execution as Tx).transaction.value = "1";
    refuses(token.execution, token.intent, /sends the native coin too/);
    const coin = fixture("8453 native->token relay");
    (coin.execution as Tx).transaction.value = (BigInt(coin.intent.inputAmount) + 1n).toString();
    refuses(coin.execution, coin.intent, /more of the native coin than the swap's amount/);
  });

  it("refuses a 0x AllowanceHolder call that pulls more than the amount (a standing allowance would cover it)", () => {
    const { execution, intent } = fixture("8453 token->native 0x_swap");
    const e = execution as Tx;
    const data = e.transaction.data!;
    e.transaction.data = data.slice(0, 10 + 128) + word(BigInt(intent.inputAmount) * 10n) + data.slice(10 + 192);
    e.calls![1].data = e.transaction.data;
    refuses(e, intent, /takes more than the swap's amount/);
  });

  it("refuses a call RAVN's execution doesn't describe riding in `calls`", () => {
    const { execution, intent } = swap();
    const e = execution as Tx;
    e.calls!.push({ to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: transfer(ATTACKER, 1n), value: "0", chainId: 8453 });
    refuses(e, intent, /calls aren't the transactions it describes/);
  });

  it("holds the swap's call in `calls` to the swap's gasLimit, and refuses one on any other call", () => {
    const { execution, intent } = swap();
    const e = execution as Tx;
    const swapCall = e.calls!.findIndex((c) => c.data === e.transaction.data);
    e.transaction.gasLimit = "300000";
    e.calls![swapCall].gasLimit = "300000";
    expect(() => checkExecution(e, intent)).not.toThrow();
    e.calls![swapCall].gasLimit = "21000";
    refuses(e, intent, /calls aren't the transactions it describes/);
    e.calls![swapCall].gasLimit = "300000";
    e.calls![0].gasLimit = "21000";
    refuses(e, intent, /calls aren't the transactions it describes/);
  });

  it("refuses a transaction for another chain", () => {
    const { execution, intent } = swap();
    (execution as Tx).transaction.chainId = 1;
    refuses(execution, intent, /not the swap's chain/);
  });

  it("refuses a chain this SDK doesn't know", () => {
    const { execution, intent } = swap();
    refuses(execution, { ...intent, inputChainId: 7777 }, /doesn't know chain 7777/);
  });

  // Every address the check accepts on Arc, each with code there and named by the venue's own API or a
  // real Arc build (2026-10-21). A new chain inherits whole-family entries, so this pins Arc's exactly.
  it("accepts exactly Arc's verified venue contracts there", () => {
    expect([...KNOWN_CONTRACTS[5042]].sort()).toEqual(
      [
        "0x0000000000001fF3684f28c67538d4D072C22734", // 0x AllowanceHolder
        "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", // KyberSwap
        "0x4cd00e387622c35bddb9b4c962c136462338bc31", // Relay depository
        "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be", // Relay approval proxy
        "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f", // Relay router
        "0xE791A2669bef779Ff7A4A9CF789F8Ee2CA20a32c", // Across periphery (Arc)
        "0x9b4A302A548c7e313c2b74C461db7b84d3074A84", // Across SpokePool
        "0xEC000769a73b70e16f361a442292500b3BCf4A85", // Eco portal
        "0xe226e4825cb215abafad98fdd400583eab6a594f", // Layerswap depository
        "0x20f6ee51340adeed01a59b0e65cb3703f3dc860c", // Fly Trade
        "0x4E3bcCE28cAf98A143Fd8BD9e4875ccAb3E7bBE0", // OKX router
        "0x2B9899bC46Bf0eE094225995f4bD496d42f261Af", // OKX approvals
        "0x5fA58e4E89c85B8d678Ade970bD6afD4311aF17E", // Garden USDC
        "0x89b6612A2121BFBd1c2Dc593504AbE4e5d5E9296", // Garden cirBTC
      ].map((a) => a.toLowerCase()).sort()
    );
  });

  it("knows Arc's own Across periphery there, not the one other chains use (no code at it on Arc)", () => {
    const { execution, intent } = fixture("5042->8453 swap+bridge across");
    expect(() => checkExecution(execution, intent)).not.toThrow();
    const e = execution as Tx;
    e.transaction.to = "0x97CCDBea4632140639aD5eA9b944aa034eb15fD4";
    e.calls![e.calls!.length - 1].to = e.transaction.to;
    refuses(e, intent, /contract RAVN doesn't route through/);
  });

  it("accepts Route's RouteEntry on Robinhood Chain only", () => {
    const entry = "0x15dbb64b42eabe52a6ddc377e966f408756815be";
    expect(Object.keys(KNOWN_CONTRACTS).filter((c) => KNOWN_CONTRACTS[Number(c)].includes(entry))).toEqual(["4663"]);
  });
});

describe("checkExecution: RAVN's fee", () => {
  type Tx = Extract<ExecutionDTO, { executionType: "TRANSACTION" }>;
  const withFee = () => fixture("8453 xchain token eco");

  it("refuses a fee to anyone but RAVN's wallet", () => {
    const a = withFee();
    (a.execution as Tx).fee!.address = ATTACKER;
    refuses(a.execution, a.intent, /RAVN's fee wallet/);
    const b = withFee();
    const fee = (b.execution as Tx).fee!;
    fee.transaction!.data = transfer(ATTACKER, BigInt(fee.amount));
    refuses(b.execution, b.intent, /isn't to RAVN's fee wallet/);
  });

  it("refuses a fee above 1% of the swap, or a payment above the stated fee", () => {
    const a = withFee();
    (a.execution as Tx).fee!.amount = (BigInt(a.intent.inputAmount) / 50n).toString();
    refuses(a.execution, a.intent, /more than 1% of the swap/);
    const b = withFee();
    const fee = (b.execution as Tx).fee!;
    fee.transaction!.data = transfer(FEE_WALLET, BigInt(fee.amount) + 1n);
    refuses(b.execution, b.intent, /more than the fee/);
  });

  it("refuses a coin fee carrying calldata beyond a tag (a call into the wallet)", () => {
    const { execution, intent } = fixture("8453 xchain native layerswap");
    (execution as Tx).fee!.transaction!.data = `0xa9059cbb${word(ATTACKER)}${word(1n)}`;
    refuses(execution, intent, /more than a tag/);
  });
});

describe("checkExecution: EVM deposits", () => {
  type Dep = Extract<ExecutionDTO, { executionType: "DEPOSIT" }>;

  it("refuses a deposit plus fee beyond the swap's amount", () => {
    const { execution, intent } = fixture("8453 private token near_intents");
    (execution as Dep).deposit.amount = intent.inputAmount;
    refuses(execution, intent, /come to more than the swap's amount/);
  });

  it("refuses a deposit call that pays someone other than the deposit address", () => {
    const { execution, intent } = fixture("8453 xchain token near_intents");
    const e = execution as Dep;
    e.calls![0].data = transfer(ATTACKER, BigInt(e.deposit.amount));
    refuses(e, intent, /isn't to the deposit address/);
  });

  it("refuses a deposit address that is a venue contract, a token or RAVN's wallet", () => {
    const { execution, intent } = fixture("8453 xchain token near_intents");
    const e = execution as Dep;
    e.deposit.address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    refuses(e, intent, /token, venue contract or RAVN's own wallet/);
  });
});

describe("checkExecution: signatures", () => {
  type Sig = Extract<ExecutionDTO, { executionType: "SIGNATURE" }>;
  const message = (e: ExecutionDTO) => (e as Sig).typedData!.message as Record<string, unknown>;

  it("refuses a CoW order paying someone else, selling more, or selling another token", () => {
    const a = fixture("8453 token->native cow");
    message(a.execution).receiver = ATTACKER;
    refuses(a.execution, a.intent, /pays someone other than the user/);
    const b = fixture("8453 token->native cow");
    message(b.execution).sellAmount = (BigInt(b.intent.inputAmount) + 1n).toString();
    refuses(b.execution, b.intent, /sells more than the swap's amount/);
    const c = fixture("8453 token->native cow");
    message(c.execution).sellToken = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
    refuses(c.execution, c.intent, /sells a token other/);
  });

  it("refuses a Permit2 transfer of more than the amount or of another token", () => {
    const a = fixture("8453 token->native 0x_gasless");
    (message(a.execution).permitted as Record<string, unknown>).amount = MAX.toString();
    refuses(a.execution, a.intent, /Permit2 transfer is for more/);
    const b = fixture("8453 token->native bebop");
    const sig = FIXTURES.find((f) => f.name === "8453 token->native bebop" && f.execution.executionType === "SIGNATURE")!;
    const e = structuredClone(sig.execution) as Sig;
    (e.typedData!.message as { permitted: { token: string } }).permitted.token = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
    refuses(e, b.intent, /Permit2 transfer is for another token/);
  });

  it("refuses a token permit to a spender RAVN doesn't use, or unlimited to a non-signature spender", () => {
    const a = fixture("8453 token->native 0x_gasless");
    ((a.execution as Sig).approvalData!.message as Record<string, unknown>).spender = ATTACKER;
    refuses(a.execution, a.intent, /permit names a spender/);
    const b = fixture("8453 token->native 0x_gasless");
    ((b.execution as Sig).approvalData!.message as Record<string, unknown>).spender = "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be";
    refuses(b.execution, b.intent, /permit is for more than the swap's amount/);
  });

  it("refuses an EIP-3009 authorization of more than the amount, or from another wallet", () => {
    const a = fixture("8453 xchain token relay");
    message(a.execution).value = MAX.toString();
    refuses(a.execution, a.intent, /authorization is for more/);
    const b = fixture("8453 xchain token relay");
    message(b.execution).from = ATTACKER;
    refuses(b.execution, b.intent, /another wallet's funds/);
  });

  it("refuses a kind of signature it doesn't know, and one for another chain", () => {
    const a = fixture("8453 token->native cow");
    const typed = (a.execution as Sig).typedData! as { primaryType: string; types: Record<string, unknown> };
    typed.primaryType = "PermitBatch";
    refuses(a.execution, a.intent, /sign something other than its primaryType/);
    typed.types.PermitBatch = typed.types.Order;
    delete typed.types.Order;
    refuses(a.execution, a.intent, /kind this SDK doesn't recognise/);
    const b = fixture("8453 token->native cow");
    ((b.execution as Sig).typedData!.domain as Record<string, unknown>).chainId = 1;
    refuses(b.execution, b.intent, /not the swap's chain/);
    ((b.execution as Sig).typedData!.domain as Record<string, unknown>).chainId = null;
    refuses(b.execution, b.intent, /names no chain/);
  });

  it("refuses types that make a wallet sign another struct than primaryType (ethers works it out from types)", () => {
    // Claimed as 0x gasless's one-time Permit2 transfer; ethers would sign an unlimited PermitSingle allowance.
    const { execution, intent } = fixture("8453 token->native 0x_gasless");
    const typed = (execution as Sig).typedData! as { types: Record<string, unknown>; message: Record<string, unknown> };
    typed.types = {
      PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
      PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
    };
    typed.message.details = { token: intent.inputToken, amount: MAX.toString(), expiration: "281474976710655", nonce: "0" };
    typed.message.spender = ATTACKER;
    refuses(execution, intent, /sign something other than its primaryType/);
  });

  it("refuses a token's own permit or EIP-3009 authorization signing other fields than the standard's", () => {
    // DAI's Permit of the same name: the check would read owner/value, the wallet sign an unlimited,
    // never-expiring allowance (allowed: true, expiry: 0) that DAI accepts.
    const { execution, intent } = fixture("8453 token->native 0x_gasless");
    const permit = (execution as Sig).approvalData! as { types: Record<string, unknown>; message: Record<string, unknown> };
    permit.types.Permit = [
      { name: "holder", type: "address" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "allowed", type: "bool" },
    ];
    Object.assign(permit.message, { holder: intent.userAddress, expiry: 0, allowed: true });
    refuses(execution, intent, /signs other fields than its kind's/);

    // One field whose type spells out the rest of the standard's list: compared joined, it passed.
    const joined = fixture("8453 token->native 0x_gasless");
    const joinedPermit = (joined.execution as Sig).approvalData! as { types: Record<string, unknown> };
    joinedPermit.types.Permit = [{ name: "owner", type: "address,spender:address,value:uint256,nonce:uint256,deadline:uint256" }];
    refuses(joined.execution, joined.intent, /signs other fields than its kind's/);

    const relay = fixture("8453 xchain token relay");
    const auth = (relay.execution as Sig).typedData! as { types: Record<string, { name: string; type: string }[]> };
    auth.types.ReceiveWithAuthorization = auth.types.ReceiveWithAuthorization.map((f) => (f.name === "value" ? { name: "amount", type: "uint256" } : f));
    refuses(relay.execution, relay.intent, /signs other fields than its kind's/);
  });
});

// ---- Solana: a minimal legacy transaction, built here --------------------------------------

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): number[] {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return out;
}
const le = (v: bigint, n: number) => Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER = "4z3RbrffSgcYwCx1C85PVMqmVbeUM29QUetScChuqCvU";
const solTransfer = (to: string, lamports: bigint) => ({ program: SYSTEM, accounts: [USER, to], data: [2, 0, 0, 0, ...le(lamports, 8)] });
const tokenIx = (kind: number, accounts: string[], amount = 0n) => ({ program: TOKEN, accounts, data: [kind, ...le(amount, 8)] });

function solanaTx(ixs: { program: string; accounts: string[]; data: number[] }[]): string {
  const keys = [USER];
  for (const ix of ixs) for (const k of [...ix.accounts, ix.program]) if (!keys.includes(k)) keys.push(k);
  const bytes = [1, ...new Array(64).fill(0), 1, 0, 0, keys.length, ...keys.flatMap(b58decode), ...new Array(32).fill(7), ixs.length];
  for (const ix of ixs) bytes.push(keys.indexOf(ix.program), ix.accounts.length, ...ix.accounts.map((a) => keys.indexOf(a)), ix.data.length, ...ix.data);
  return Buffer.from(bytes).toString("base64");
}
const solSwap = (serialized: string): ExecutionDTO => ({ executionType: "TRANSACTION", quoteToken: "qt", transaction: { serialized } });
const SOL_INTENT: SwapIntent = { inputChainId: -2, inputToken: USDC, inputAmount: "100000000", userAddress: USER };
const JUPITER = { program: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", accounts: [USER], data: [1, 2, 3] };

describe("checkExecution: Solana", () => {
  const userUsdc = associatedTokenAddress(USER, USDC, TOKEN)!;

  it("derives associated token accounts the way Solana does", () => {
    // The user's USDC account, as its real transactions name it.
    expect(userUsdc).toBe("FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B");
    expect(Buffer.from(sha256(new TextEncoder().encode("abc"))).toString("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("accepts a venue's swap that keeps within the input token and amount", () => {
    expect(() => checkExecution(solSwap(solanaTx([tokenIx(3, [userUsdc, OTHER, USER], 1_000_000n), JUPITER])), SOL_INTENT)).not.toThrow();
  });

  it("refuses a program RAVN doesn't route through", () => {
    refuses(solSwap(solanaTx([{ program: OTHER, accounts: [USER], data: [0] }])), SOL_INTENT, /program RAVN doesn't route through/);
  });

  it("refuses moving another token, more than the amount, an approval, a change of owner, or closing to someone else", () => {
    const otherAta = associatedTokenAddress(USER, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", TOKEN)!;
    refuses(solSwap(solanaTx([tokenIx(3, [otherAta, OTHER, USER], 1n)])), SOL_INTENT, /token other than the one being swapped/);
    refuses(solSwap(solanaTx([tokenIx(3, [userUsdc, OTHER, USER], 100_000_001n)])), SOL_INTENT, /more of the token than the swap's amount/);
    refuses(solSwap(solanaTx([tokenIx(4, [userUsdc, OTHER, USER], 1n)])), SOL_INTENT, /an approval, a change of owner, a burn/);
    refuses(solSwap(solanaTx([{ program: TOKEN, accounts: [userUsdc, USER], data: [6, 2, 1, ...b58decode(OTHER)] }])), SOL_INTENT, /an approval, a change of owner/);
    refuses(solSwap(solanaTx([tokenIx(9, [userUsdc, OTHER, USER])])), SOL_INTENT, /closes the user's account to someone else/);
  });

  it("refuses SOL beyond rent on a token sell, and handing the user's account to a program", () => {
    refuses(solSwap(solanaTx([solTransfer(OTHER, 100_000_000n)])), SOL_INTENT, /more SOL than its account rent/);
    refuses(solSwap(solanaTx([{ program: SYSTEM, accounts: [USER], data: [1, 0, 0, 0, ...b58decode(OTHER)] }])), SOL_INTENT, /hands the user's account to a program/);
  });

  it("holds a deposit RAVN built to exactly the deposit and RAVN's fee", () => {
    const sol: SwapIntent = { ...SOL_INTENT, inputToken: "So11111111111111111111111111111111111111112", inputAmount: "500000000" };
    const deposit = (ixs: ReturnType<typeof solTransfer>[]): ExecutionDTO => ({
      executionType: "DEPOSIT",
      quoteToken: "qt",
      statusRef: OTHER,
      deposit: { address: OTHER, amount: "497500000", chainId: -2, transaction: solanaTx(ixs) },
      fee: { amount: "2500000", address: "4pQtttNDe8kdQjhJ22LA2Tqnen9smPjoJj7HM3X8ZNYf", chainId: -2 },
    });
    const fee = solTransfer("4pQtttNDe8kdQjhJ22LA2Tqnen9smPjoJj7HM3X8ZNYf", 2_500_000n);
    expect(() => checkExecution(deposit([solTransfer(OTHER, 497_500_000n), fee]), sol)).not.toThrow();
    refuses(deposit([solTransfer(OTHER, 497_500_000n), fee, solTransfer(USDC, 1n)]), sol, /to someone other than the deposit or RAVN's fee/);
    refuses(deposit([solTransfer(OTHER, 400_000_000n), fee]), sol, /doesn't pay the deposit exactly its amount/);
  });
});

// ---- Bitcoin: a minimal PSBT, built here ---------------------------------------------------

const BTC_USER = "bc1qj2qrg8qrpnpw70cd99z90j6h0pzhscgmt0c78g";
const BTC_DEPOSIT = "bc1qjzfhpj264xxnyx922l0mjt5wvhqw9xm3yyecrz";
const BTC_FEE = "bc1qe8px5j4l6sexjzgs7a4khwt9tmhrzfgf3nuzsa";
// P2WPKH script of a bc1q address, decoded with the SDK's own rules' expectations in mind.
function p2wpkh(address: string): number[] {
  const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = [...address.slice(address.lastIndexOf("1") + 1, -6)].map((c) => CH.indexOf(c)).slice(1);
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const d of data) {
    acc = ((acc << 5) | d) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return [0, 20, ...out];
}
function psbt(inputs: { value: bigint; owner: string; extra?: number[] }[], outputs: { value: bigint; to: string }[]): string {
  const varint = (n: number) => [n];
  const tx = [2, 0, 0, 0, ...varint(inputs.length)];
  inputs.forEach((_, i) => tx.push(...new Array(32).fill(i + 1), 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff));
  tx.push(...varint(outputs.length));
  for (const o of outputs) tx.push(...le(o.value, 8), ...varint(p2wpkh(o.to).length), ...p2wpkh(o.to));
  tx.push(0, 0, 0, 0);
  const bytes = [0x70, 0x73, 0x62, 0x74, 0xff, 1, 0, ...varint(tx.length), ...tx, 0];
  for (const i of inputs) {
    const utxo = [...le(i.value, 8), ...varint(22), ...p2wpkh(i.owner)];
    bytes.push(1, 1, ...varint(utxo.length), ...utxo, ...(i.extra ?? []), 0);
  }
  for (let k = 0; k < outputs.length; k++) bytes.push(0);
  return Buffer.from(bytes).toString("base64");
}

describe("checkExecution: Bitcoin PSBTs", () => {
  const intent: SwapIntent = { inputChainId: -1, inputToken: "native", inputAmount: "200000", userAddress: BTC_USER };
  const deposit = (b64: string): ExecutionDTO => ({
    executionType: "DEPOSIT",
    quoteToken: "qt",
    statusRef: BTC_DEPOSIT,
    deposit: { address: BTC_DEPOSIT, amount: "199000", chainId: -1, psbt: b64 },
    fee: { amount: "1000", address: BTC_FEE, chainId: -1 },
  });
  const ins = [{ value: 600_000n, owner: BTC_USER }];
  const good = [
    { value: 199_000n, to: BTC_DEPOSIT },
    { value: 1_000n, to: BTC_FEE },
    { value: 399_000n, to: BTC_USER },
  ];

  it("accepts the deposit, RAVN's fee and change back to the sender", () => {
    expect(() => checkExecution(deposit(psbt(ins, good)), intent)).not.toThrow();
  });

  it("refuses an output to anyone else, a short deposit, change elsewhere, someone else's coins, or an absurd network fee", () => {
    refuses(deposit(psbt(ins, [...good.slice(0, 2), { value: 399_000n, to: "bc1qhne88dzltx85lhvc56888hslfxntrjxdrvh3y8" }])), intent, /neither the deposit/);
    refuses(deposit(psbt(ins, [{ value: 1n, to: BTC_DEPOSIT }, ...good.slice(1)])), intent, /exactly its amount/);
    refuses(deposit(psbt([{ value: 600_000n, owner: "bc1qhne88dzltx85lhvc56888hslfxntrjxdrvh3y8" }], good)), intent, /aren't the sender's/);
    refuses(deposit(psbt([{ value: 5_000_000n, owner: BTC_USER }], good)), intent, /absurdly high/);
  });

  it("checks the real PSBT RAVN built", () => {
    const real = FIXTURES.find((f) => f.name === "-1 psbt private btc->base near_intents")!;
    expect(() => checkExecution(real.execution, real.intent)).not.toThrow();
    expect(() => checkExecution(real.execution, { ...real.intent, userAddress: BTC_DEPOSIT })).toThrow(UnsafeExecutionError);
  });
});

// ---- RavnClient: every execute() is checked ------------------------------------------------

describe("RavnClient.execute runs the check", () => {
  const real = () => fixture("8453 token->native relay");
  const quote = (quoteToken: string, alternatives: string[] = []) => ({ quoteToken, alternatives: alternatives.map((t) => ({ quoteToken: t })) });
  const api = (answers: Record<string, unknown>) => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname.split("/").pop()!;
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ data: answers[path] }) };
    });
    return fetchImpl as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  };

  it("checks an execution against the quote this client fetched, alternatives included", async () => {
    const { execution, intent } = real();
    const fetchImpl = api({ quote: quote("q1", ["alt"]), execute: execution });
    const client = new RavnClient({ fetch: fetchImpl });
    await client.getQuote({ ...intent, outputChainId: 8453, outputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" });
    await expect(client.execute({ quoteToken: "q1" })).resolves.toEqual(execution);
    await expect(client.execute({ quoteToken: "alt" })).resolves.toEqual(execution);
  });

  it("refuses a tampered answer: nothing to hand to a wallet", async () => {
    const { execution, intent } = real();
    (execution as Extract<ExecutionDTO, { executionType: "TRANSACTION" }>).transaction.to = ATTACKER;
    const client = new RavnClient({ fetch: api({ quote: quote("q1"), execute: execution }) });
    await client.getQuote({ ...intent, outputChainId: 8453, outputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" });
    await expect(client.execute({ quoteToken: "q1" })).rejects.toThrow(UnsafeExecutionError);
  });

  it("refuses a quoteToken it didn't fetch before calling the API, and checks it when given the intent", async () => {
    const { execution, intent } = real();
    const fetchImpl = api({ execute: execution });
    const client = new RavnClient({ fetch: fetchImpl });
    await expect(client.execute({ quoteToken: "elsewhere" })).rejects.toThrow(/didn't fetch it/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(client.execute({ quoteToken: "elsewhere" }, { intent })).resolves.toEqual(execution);
    await expect(client.execute({ quoteToken: "elsewhere" }, { intent: { ...intent, inputAmount: "1" } })).rejects.toThrow(UnsafeExecutionError);
  });

  it("guard: false passes answers through unchecked", async () => {
    const { execution } = real();
    (execution as Extract<ExecutionDTO, { executionType: "TRANSACTION" }>).transaction.to = ATTACKER;
    const client = new RavnClient({ fetch: api({ execute: execution }), guard: false });
    await expect(client.execute({ quoteToken: "anything" })).resolves.toEqual(execution);
  });

  it("allowContracts admits a venue's new contract", async () => {
    const { execution, intent } = fixture("8453 native->token relay");
    (execution as Extract<ExecutionDTO, { executionType: "TRANSACTION" }>).transaction.to = ATTACKER;
    (execution as Extract<ExecutionDTO, { executionType: "TRANSACTION" }>).calls![0].to = ATTACKER;
    const client = new RavnClient({ fetch: api({ execute: execution }), guard: { allowContracts: { 8453: [ATTACKER] } } });
    await expect(client.execute({ quoteToken: "x" }, { intent })).resolves.toEqual(execution);
  });
});

// ---- What an independent review broke in the first version, each now refused ---------------

describe("checkExecution: hardened after review", () => {
  type Tx = Extract<ExecutionDTO, { executionType: "TRANSACTION" }>;
  type Dep = Extract<ExecutionDTO, { executionType: "DEPOSIT" }>;

  it("refuses a negative amount, which would make a deposit plus fee look smaller", () => {
    const { execution, intent } = fixture("8453 private token near_intents");
    const e = execution as Dep;
    e.deposit.amount = "9000000100000000";
    (e.fee as unknown as { amount: number }).amount = -9_000_000_000_000_000;
    delete e.fee!.transaction;
    e.calls = [{ ...e.calls![0], data: transfer(e.deposit.address, 9_000_000_100_000_000n) }];
    refuses(e, intent, /isn't a whole number/);
  });

  it("leaves a sandbox execution unchecked only when the quote asked for one", () => {
    const { execution, intent } = fixture("8453 token->native relay");
    const e = { ...execution, sandbox: true } as Tx;
    e.transaction.to = ATTACKER;
    refuses(e, intent, /marked this execution as a sandbox one/);
    expect(() => checkExecution(e, { ...intent, sandbox: true })).not.toThrow();
  });

  it("refuses a transaction or approval that names no chain", () => {
    const a = fixture("8453 native->token relay");
    delete (a.execution as Tx).transaction.chainId;
    refuses(a.execution, a.intent, /names no chain/);
    const b = fixture("8453 token->native relay");
    delete (b.execution as Tx).approval!.chainId;
    refuses(b.execution, b.intent, /names no chain/);
  });

  it("refuses approval fields that don't say what the calldata approves", () => {
    const a = fixture("8453 token->native relay");
    (a.execution as Tx).approval!.spender = ATTACKER;
    refuses(a.execution, a.intent, /spender isn't the one its calldata approves/);
    const b = fixture("8453 token->native relay");
    (b.execution as Tx).approval!.amount = MAX.toString();
    refuses(b.execution, b.intent, /amount isn't the one its calldata approves/);
    const c = fixture("8453 token->native relay");
    (c.execution as Tx).approval!.unlimitedRecommended = true;
    refuses(c.execution, c.intent, /unlimited approval is recommended/);
  });

  it("refuses RAVN's fee on top of approving the whole amount", () => {
    const { execution, intent } = fixture("8453 xchain token eco");
    const e = execution as Tx;
    e.approval!.data = approve("0xEC000769a73b70e16f361a442292500b3BCf4A85", BigInt(intent.inputAmount));
    e.approval!.amount = intent.inputAmount;
    e.calls![0].data = e.approval!.data;
    refuses(e, intent, /take more of the token than the swap's amount/);
  });

  it("refuses an order on a chain with no CoW, whatever it claims", () => {
    const { execution, intent } = fixture("8453 token->native cow");
    const e = execution as Extract<ExecutionDTO, { executionType: "SIGNATURE" }>;
    delete e.approval;
    e.typedData!.domain = { chainId: 10 };
    refuses(e, { ...intent, inputChainId: 10 }, /names no contract/);
  });

  it("refuses an intent naming a token by symbol, which it can't hold RAVN to", () => {
    const { execution, intent } = fixture("8453 token->native relay");
    refuses(execution, { ...intent, inputToken: "USDC" }, /isn't an address/);
  });

  it("holds a SOL sell to one budget for SOL and wrapped SOL", () => {
    const sol: SwapIntent = { ...SOL_INTENT, inputToken: "So11111111111111111111111111111111111111112", inputAmount: "500000000" };
    const wsol = associatedTokenAddress(USER, "So11111111111111111111111111111111111111112", TOKEN)!;
    const wrap = solTransfer(wsol, 500_000_000n);
    expect(() => checkExecution(solSwap(solanaTx([wrap, JUPITER])), sol)).not.toThrow();
    refuses(solSwap(solanaTx([solTransfer(OTHER, 500_000_000n), tokenIx(3, [wsol, OTHER, USER], 500_000_000n)])), sol, /more SOL than the swap/);
  });

  it("refuses paying RAVN more than its fee on Solana, and a durable nonce", () => {
    const ravnUsdc = associatedTokenAddress("4pQtttNDe8kdQjhJ22LA2Tqnen9smPjoJj7HM3X8ZNYf", USDC, TOKEN)!;
    const userUsdc = associatedTokenAddress(USER, USDC, TOKEN)!;
    refuses(solSwap(solanaTx([tokenIx(3, [userUsdc, ravnUsdc, USER], 2_000_000n)])), SOL_INTENT, /pays RAVN more than its fee/);
    refuses(solSwap(solanaTx([{ program: SYSTEM, accounts: [OTHER, SYSTEM, USER], data: [4, 0, 0, 0] }, JUPITER])), SOL_INTENT, /System call RAVN's swaps never make/);
  });

  it("refuses a PSBT asking for a signature that doesn't cover every output, or repeating a key", () => {
    const intent: SwapIntent = { inputChainId: -1, inputToken: "native", inputAmount: "200000", userAddress: BTC_USER };
    const deposit = (b64: string): ExecutionDTO => ({
      executionType: "DEPOSIT",
      quoteToken: "qt",
      statusRef: BTC_DEPOSIT,
      deposit: { address: BTC_DEPOSIT, amount: "199000", chainId: -1, psbt: b64 },
      fee: { amount: "1000", address: BTC_FEE, chainId: -1 },
    });
    const outs = [
      { value: 199_000n, to: BTC_DEPOSIT },
      { value: 1_000n, to: BTC_FEE },
      { value: 399_000n, to: BTC_USER },
    ];
    const sighash = (t: number) => [1, 3, 4, t, 0, 0, 0];
    expect(() => checkExecution(deposit(psbt([{ value: 600_000n, owner: BTC_USER, extra: sighash(1) }], outs)), intent)).not.toThrow();
    refuses(deposit(psbt([{ value: 600_000n, owner: BTC_USER, extra: sighash(2) }], outs)), intent, /doesn't cover every output/);
    refuses(deposit(psbt([{ value: 600_000n, owner: BTC_USER, extra: [...sighash(1), ...sighash(1)] }], outs)), intent, /repeats a key/);
  });
});

describe("RavnClient: a quoteToken RAVN returns for two requests", () => {
  it("can't be executed against either", async () => {
    const { execution, intent } = fixture("8453 token->native relay");
    const answers = [{ quoteToken: "T", alternatives: [] }, { quoteToken: "other", alternatives: [{ quoteToken: "T" }] }];
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname.split("/").pop()!;
      const data = path === "quote" ? answers.shift() : execution;
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ data }) };
    });
    const client = new RavnClient({ fetch: fetchImpl as unknown as typeof fetch });
    const base = { ...intent, outputChainId: 8453, outputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" };
    await client.getQuote(base);
    await client.getQuote({ ...base, inputAmount: "1" });
    await expect(client.execute({ quoteToken: "T" })).rejects.toThrow(/two different quote requests/);
  });
});

describe("hardened after the second review", () => {
  type Tx = Extract<ExecutionDTO, { executionType: "TRANSACTION" }>;

  it("refuses an approval for a contract the swap doesn't call", () => {
    const { execution, intent } = fixture("8453 token->native relay");
    const e = execution as Tx;
    e.approval!.data = approve("0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", 100_000_000n);
    e.approval!.spender = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
    e.calls![0].data = e.approval!.data;
    refuses(e, intent, /contract the swap doesn't call/);
  });

  it("refuses a chain id given as a string", () => {
    const { execution, intent } = fixture("8453 native->token relay");
    (execution as Tx).transaction.chainId = "8453" as unknown as number;
    refuses(execution, intent, /gives its chain as string, not a number/);
  });

  it("refuses a PSBT signature-type entry with a longer key", () => {
    const intent: SwapIntent = { inputChainId: -1, inputToken: "native", inputAmount: "200000", userAddress: BTC_USER };
    const outs = [
      { value: 200_000n, to: BTC_DEPOSIT },
      { value: 399_000n, to: BTC_USER },
    ];
    const b64 = psbt([{ value: 600_000n, owner: BTC_USER, extra: [2, 3, 0, 4, 2, 0, 0, 0] }], outs);
    refuses({ executionType: "DEPOSIT", quoteToken: "qt", statusRef: "r", deposit: { address: BTC_DEPOSIT, amount: "200000", chainId: -1, psbt: b64 } }, intent, /malformed signature-type/);
  });
});

describe("RavnClient: a flood of alternatives can't make it forget a quote", () => {
  it("still refuses a token it saw for another request after the memory is flushed", async () => {
    const { execution, intent } = fixture("8453 token->native relay");
    const junk = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ quoteToken: `${tag}${i}` }));
    const answers: unknown[] = [{ quoteToken: "T", alternatives: [] }];
    // Enough answers, each at the per-answer cap, to push T out of the intent memory.
    for (let k = 0; k < 20; k++) answers.push({ quoteToken: `q${k}`, alternatives: junk(1_001, `j${k}_`) });
    answers.push({ quoteToken: "again", alternatives: [{ quoteToken: "T" }] });
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname.split("/").pop()!;
      const data = path === "quote" ? answers.shift() : execution;
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ data }) };
    });
    const client = new RavnClient({ fetch: fetchImpl as unknown as typeof fetch });
    const base = { ...intent, outputChainId: 8453, outputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" };
    await client.getQuote(base);
    for (let k = 0; k < 21; k++) await client.getQuote({ ...base, inputAmount: "1" });
    await expect(client.execute({ quoteToken: "T" })).rejects.toThrow(/two different quote requests/);
    // Past the per-answer cap a token isn't remembered at all, so it can't be executed unchecked.
    await expect(client.execute({ quoteToken: "j0_1000" })).rejects.toThrow(/didn't fetch it/);
  });
});
