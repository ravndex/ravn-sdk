import { afterEach, describe, expect, it, vi } from "vitest";
import { RavnClient } from "./client";
import { executeAndTrack, ExecuteAndTrackError } from "./execute-and-track";
import { checkExecution, checkRecovery } from "./guard";
import { recoverStuckFunds } from "./recover";
import type { SwapIntent } from "./guard";
import { UnsafeExecutionError } from "./types";
import type { AuthorizeDTO, ExecutionDTO, RecoverDTO } from "./types";

// Hinkal, a private swap: two AUTHORIZE steps (a read-only session, then the order), then the
// deposit into Hinkal.sol. Shapes as ravn-mvp's hinkal adapter builds them (lib/hinkal/order.ts).

const HINKAL = "0x7cb60446d7635C68EDf1c568cac74A1f98c1Cfa4";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";
const FEE_WALLET = "0x12d2425fD88c693EDB4dE004E0c747879B7D6933";
const USER = "0x1111111111111111111111111111111111111111";
const DEST = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const AMOUNT_IN = 99_400_000n;
const FEE = 500_000n;

const intent: SwapIntent = { inputChainId: 8453, inputToken: USDC, inputAmount: "100000000", userAddress: USER, destinationAddress: DEST };
const nativeIntent: SwapIntent = { ...intent, inputToken: NATIVE, inputAmount: "1000000000000000000" };

const word = (v: string | bigint) => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "").toLowerCase()).padStart(64, "0");
const approve = (spender: string, amount: bigint) => `0x095ea7b3${word(spender)}${word(amount)}`;
const transfer = (to: string, amount: bigint) => `0xa9059cbb${word(to)}${word(amount)}`;
// prooflessDeposit([token], [amount], [(1,2,3,4,5)], [0xabcd], true, "order-123"), as viem encodes it.
const deposit = (token: string, amount: bigint, selector = "0xbb3b5d78") =>
  selector +
  [0xc0n, 0x100n, 0x140n, 0x200n, 1n, 0x280n, 1n, token, 1n, amount, 1n, 1n, 2n, 3n, 4n, 5n, 1n, 0x20n, 2n].map(word).join("") +
  "abcd".padEnd(64, "0") +
  word(9n) +
  Buffer.from("order-123").toString("hex").padEnd(64, "0");

const SESSION = `Authorize Hinkal session\nSession ID: 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b\nPublic Key: 02${"ab".repeat(32)}`;
const route = (...recipients: string[]) =>
  JSON.stringify({ quote: { lifiRecipients: recipients.map((r) => ({ recipientAddress: r, quote: { nativeFee: "0" } })) } });

const order = (token = USDC, amount = AMOUNT_IN.toString()) => ({
  domain: { name: "Hinkal Enclave", chainId: 8453 } as Record<string, unknown>,
  types: {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }],
    BridgeRecipientAmount: [{ name: "recipient", type: "string" }, { name: "amount", type: "int256" }],
    PrivateSendBridge: [
      { name: "nonce", type: "string" },
      { name: "sessionId", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "tokenAddress", type: "address" },
      { name: "destinationChainId", type: "uint256" },
      { name: "destinationTokenAddress", type: "string" },
      { name: "recipients", type: "BridgeRecipientAmount[]" },
      { name: "quote", type: "string" },
    ],
  } as Partial<Record<string, { name: string; type: string }[]>>,
  primaryType: "PrivateSendBridge",
  message: {
    nonce: "5d0c3a8e-0000-4000-8000-000000000001",
    sessionId: "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b",
    chainId: 8453 as unknown,
    tokenAddress: token,
    destinationChainId: 42161,
    destinationTokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    recipients: [{ recipient: DEST, amount }] as Record<string, unknown>[],
    quote: route(DEST),
  },
});

const authorize = (sign: AuthorizeDTO["sign"], authorization = "step-1", step = 1): AuthorizeDTO => ({
  executionType: "AUTHORIZE",
  quoteToken: "qt-1",
  authorization,
  sign,
  expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  step,
  steps: 2,
});
const session = (message = SESSION) => authorize({ method: "personal_sign", message });
const placing = (typedData: ReturnType<typeof order>) => authorize({ method: "eth_signTypedData_v4", typedData }, "step-2", 2);

type Tx = Extract<ExecutionDTO, { executionType: "TRANSACTION" }>;
// A token sell's deposit as /v1/execute hands it out: approve Hinkal, deposit, RAVN's fee beside it.
const tokenSell = (): Tx => {
  const approval = { to: USDC, data: approve(HINKAL, AMOUNT_IN), value: "0", chainId: 8453, spender: HINKAL, amount: AMOUNT_IN.toString() };
  const transaction = { to: HINKAL, data: deposit(USDC, AMOUNT_IN), value: "0", chainId: 8453 };
  const fee = { to: USDC, data: transfer(FEE_WALLET, FEE) + word("0x5a"), value: "0", chainId: 8453 };
  return {
    executionType: "TRANSACTION",
    quoteToken: "qt-2",
    swapId: "swap-1",
    approval,
    transaction,
    fee: { amount: FEE.toString(), address: FEE_WALLET, chainId: 8453, transaction: fee },
    calls: [{ to: approval.to, data: approval.data, value: "0", chainId: 8453 }, transaction, fee],
    batch: true,
  };
};
const coinSell = (value = 990_000_000_000_000_000n): Tx => ({
  executionType: "TRANSACTION",
  quoteToken: "qt-2",
  transaction: { to: HINKAL, data: deposit(ZERO, value), value: value.toString(), chainId: 8453 },
});

const refuses = (e: ExecutionDTO | AuthorizeDTO, i: SwapIntent, message: RegExp) => {
  expect(() => checkExecution(e, i)).toThrow(UnsafeExecutionError);
  expect(() => checkExecution(e, i)).toThrow(message);
};

describe("checkExecution: Hinkal's read-only session (AUTHORIZE personal_sign)", () => {
  it("accepts the read-only session message", () => {
    expect(() => checkExecution(session(), intent)).not.toThrow();
    expect(() => checkExecution(session(SESSION.replace("Key: 02", "Key: 03")), intent)).not.toThrow();
  });

  it("refuses a normal-mode session, whose key can move the user's funds", () => {
    refuses(session(`${SESSION}\nThis signature can also be used to submit transactions.`), intent, /can move the user's funds/);
    refuses(session(`This signature can also be used to submit transactions.\n${SESSION}`), intent, /can move the user's funds/);
  });

  it("refuses any other message", () => {
    for (const message of [
      "",
      "Sign in to RAVN",
      `${SESSION}\n`,
      `${SESSION}\nExpires: never`,
      SESSION.replace("Authorize", "authorize"),
      SESSION.replace("Key: 02", "Key: 04"),
      SESSION.replace("abab", "ABAB"),
      SESSION.replace("3f2b8c1e-", "3f2b8c1e"),
    ]) {
      refuses(session(message), intent, /isn't a read-only Hinkal session/);
    }
  });

  it("refuses a signature method it doesn't know", () => {
    refuses(authorize({ method: "eth_sign", message: SESSION } as unknown as AuthorizeDTO["sign"]), intent, /kind this SDK doesn't recognise/);
    refuses({ ...session(), sign: undefined } as unknown as AuthorizeDTO, intent, /nothing to sign/);
  });

  it("refuses an authorization for a swap not on a chain Hinkal runs on", () => {
    refuses(session(), { ...intent, inputChainId: -2, inputToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, /doesn't know Hinkal on chain -2/);
    refuses(session(), { ...intent, inputChainId: 10 }, /doesn't know Hinkal on chain 10/);
  });

  it("checks an AUTHORIZE marked sandbox all the same: it is signed either way", () => {
    refuses({ ...session("Sign in"), sandbox: true } as AuthorizeDTO, { ...intent, sandbox: true }, /isn't a read-only Hinkal session/);
  });
});

describe("checkExecution: Hinkal's order (AUTHORIZE eth_signTypedData_v4)", () => {
  it("accepts the order: the input token, within the amount, paying the destination by a route paying it", () => {
    expect(() => checkExecution(placing(order()), intent)).not.toThrow();
    const t = order();
    t.message.recipients[0].recipient = DEST.toUpperCase().replace("0X", "0x");
    t.message.quote = route(DEST.toUpperCase().replace("0X", "0x"));
    expect(() => checkExecution(placing(t), intent)).not.toThrow();
  });

  it("accepts a coin sell's order, which names the coin as the zero address", () => {
    expect(() => checkExecution(placing(order(ZERO, "990000000000000000")), nativeIntent)).not.toThrow();
    refuses(placing(order(NATIVE, "990000000000000000")), nativeIntent, /token other than the one being swapped/);
  });

  it("refuses a domain other than Hinkal's enclave, or one naming a contract", () => {
    const named = order();
    named.domain.name = "Hinkal";
    refuses(placing(named), intent, /isn't for Hinkal's enclave/);
    const contract = order();
    contract.domain.verifyingContract = USDC;
    refuses(placing(contract), intent, /isn't for Hinkal's enclave/);
    const versioned = order();
    versioned.domain.version = "1";
    refuses(placing(versioned), intent, /isn't for Hinkal's enclave/);
  });

  it("refuses a domain on another chain, or none", () => {
    const other = order();
    other.domain.chainId = 1;
    refuses(placing(other), intent, /signature request is for chain 1/);
    const none = order();
    delete none.domain.chainId;
    refuses(placing(none), intent, /signature request names no chain/);
    const text = order();
    text.domain.chainId = "8453";
    refuses(placing(text), intent, /not a number/);
  });

  it("refuses typed data of another kind", () => {
    const t = order();
    t.primaryType = "Permit";
    refuses(placing(t), intent, /sign something other than its primaryType/);
    const renamed = order();
    renamed.types.Permit = renamed.types.PrivateSendBridge;
    delete renamed.types.PrivateSendBridge;
    renamed.primaryType = "Permit";
    refuses(placing(renamed), intent, /kind this SDK doesn't recognise/);
    refuses(authorize({ method: "eth_signTypedData_v4" } as AuthorizeDTO["sign"]), intent, /typed data is missing/);
  });

  // ethers' signer.signTypedData(domain, types, value) signs the struct `types` makes the root and
  // ignores primaryType: here Hinkal's own Withdraw (ethers' TypedDataEncoder.from(types) picks it,
  // checked once against ethers 6), which could move the user's Hinkal funds.
  it("refuses types whose root isn't the PrivateSendBridge the guard reads", () => {
    const withdraw = order();
    withdraw.types = {
      EIP712Domain: withdraw.types.EIP712Domain,
      Withdraw: [
        { name: "nonce", type: "string" },
        { name: "sessionId", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "tokenAmounts", type: "TokenAmount[]" },
        { name: "recipient", type: "string" },
      ],
      TokenAmount: [{ name: "token", type: "address" }, { name: "amount", type: "int256" }],
    };
    Object.assign(withdraw.message, { tokenAmounts: [{ token: USDC, amount: "1000000000000" }], recipient: ATTACKER });
    refuses(placing(withdraw), intent, /sign something other than its primaryType/);

    const extra = order();
    extra.types.Withdraw = withdraw.types.Withdraw;
    extra.types.TokenAmount = withdraw.types.TokenAmount;
    refuses(placing(extra), intent, /sign something other than its primaryType/);

    const none = order() as Partial<ReturnType<typeof order>>;
    delete none.types;
    refuses(placing(none as ReturnType<typeof order>), intent, /names no types/);
  });

  it("refuses an order on another chain", () => {
    const t = order();
    t.message.chainId = 1;
    refuses(placing(t), intent, /order is for chain 1/);
    delete t.message.chainId;
    refuses(placing(t), intent, /order names no chain/);
  });

  it("refuses an order for another token", () => {
    refuses(placing(order("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2")), intent, /token other than the one being swapped/);
    refuses(placing(order(ZERO)), intent, /token other than the one being swapped/);
  });

  it("refuses an order paying anything but exactly one recipient", () => {
    const two = order();
    two.message.recipients.push({ recipient: ATTACKER, amount: "1" });
    refuses(placing(two), intent, /exactly one recipient/);
    const none = order();
    none.message.recipients = [];
    refuses(placing(none), intent, /exactly one recipient/);
  });

  it("refuses an order for more than the swap's amount", () => {
    refuses(placing(order(USDC, "100000001")), intent, /more than the swap's amount/);
    refuses(placing(order(USDC, "-1")), intent, /isn't a whole number/);
    expect(() => checkExecution(placing(order(USDC, "100000000")), intent)).not.toThrow();
  });

  it("refuses an order paying someone other than the destination", () => {
    const t = order();
    t.message.recipients[0].recipient = ATTACKER;
    refuses(placing(t), intent, /pays someone other than the destination/);
  });

  it("holds a Solana payout to its exact address", () => {
    const sol = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const t = order();
    t.message.recipients[0].recipient = sol;
    t.message.quote = route(sol);
    expect(() => checkExecution(placing(t), { ...intent, destinationAddress: sol })).not.toThrow();
    refuses(placing(t), { ...intent, destinationAddress: sol.toLowerCase() }, /pays someone other than the destination/);
  });

  it("holds an order to the user's own wallet when the caller named no destination", () => {
    const { destinationAddress: _, ...noDestination } = intent;
    refuses(placing(order()), noDestination, /pays someone other than the destination/);
    const own = order();
    own.message.recipients[0].recipient = USER;
    expect(() => checkExecution(placing(own), noDestination)).not.toThrow();
  });
});

describe("checkExecution: Hinkal's deposit (TRANSACTION)", () => {
  it("accepts a token sell's approval, deposit and RAVN's fee", () => {
    expect(() => checkExecution(tokenSell(), intent)).not.toThrow();
  });

  it("accepts a coin sell's deposit, the coin sent with it", () => {
    expect(() => checkExecution(coinSell(), nativeIntent)).not.toThrow();
  });

  it("refuses any other call to Hinkal", () => {
    const e = tokenSell();
    e.transaction.data = deposit(USDC, AMOUNT_IN, "0xa9059cbb");
    refuses(e, intent, /call to Hinkal isn't a deposit/);
  });

  it("refuses a deposit of another token", () => {
    const e = tokenSell();
    e.transaction.data = deposit("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", AMOUNT_IN);
    refuses(e, intent, /Hinkal deposit is for a token other/);
    refuses(coinSell(), intent, /Hinkal deposit is for a token other/);
    const coin = coinSell();
    coin.transaction.data = deposit(USDC, 1n);
    refuses(coin, nativeIntent, /Hinkal deposit is for a token other/);
  });

  it("refuses a deposit for more than the swap, even where an earlier allowance stands in for the approval", () => {
    const e = tokenSell();
    delete e.approval;
    delete e.calls;
    e.transaction.data = deposit(USDC, 100_000_001n);
    refuses(e, intent, /Hinkal deposit is for more than the swap's amount/);
  });

  it("refuses a deposit whose amount and RAVN's fee come to more than the swap", () => {
    const e = tokenSell();
    e.transaction.data = deposit(USDC, 99_600_000n);
    delete e.calls;
    refuses(e, intent, /take more of the token than the swap's amount/);
  });

  it("refuses a deposit of several tokens, or calldata it can't read as Hinkal's", () => {
    const several = tokenSell();
    several.transaction.data = several.transaction.data!.replace(word(1n) + word(USDC), word(2n) + word(USDC));
    refuses(several, intent, /exactly one token/);
    const shifted = tokenSell();
    shifted.transaction.data = `0xbb3b5d78${word(0xc1n)}${shifted.transaction.data!.slice(74)}`;
    refuses(shifted, intent, /isn't ABI-encoded/);
    const short = tokenSell();
    short.transaction.data = `0xbb3b5d78${word(0xc0n)}`;
    refuses(short, intent, /shorter than its function's arguments/);
  });

  it("refuses the coin sent on a token sell, or more of it than the swap on a coin sell", () => {
    const e = tokenSell();
    e.transaction.value = "1";
    delete e.calls;
    refuses(e, intent, /sends the native coin too/);
    refuses(coinSell(1_000_000_000_000_000_001n), nativeIntent, /more than the swap's amount/);
    const value = coinSell();
    value.transaction.value = "1000000000000000001";
    refuses(value, nativeIntent, /more of the native coin than the swap's amount/);
  });

  it("refuses an approval of Hinkal beside a call to another contract, and another spender beside the deposit", () => {
    const e = tokenSell();
    e.transaction.to = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
    delete e.calls;
    // Hinkal is known only to a transaction that deposits into it.
    refuses(e, intent, /spender RAVN doesn't route through/);
    const other = tokenSell();
    other.approval!.data = approve("0x4cd00e387622c35bddb9b4c962c136462338bc31", AMOUNT_IN);
    other.approval!.spender = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
    delete other.calls;
    refuses(other, intent, /contract the swap doesn't call/);
  });

  it("refuses Hinkal on a chain it doesn't run on", () => {
    const e = coinSell();
    e.transaction.chainId = 10;
    refuses(e, { ...nativeIntent, inputChainId: 10 }, /contract RAVN doesn't route through/);
  });

  it("knows Hinkal on each chain it runs on", () => {
    for (const chainId of [1, 8453, 42161, 137, 56, 4663]) {
      const e = coinSell();
      e.transaction.chainId = chainId;
      expect(() => checkExecution(e, { ...nativeIntent, inputChainId: chainId })).not.toThrow();
    }
  });

  it("never lets a signature name Hinkal: an EIP-3009 transfer to it would strand the funds outside any deposit", () => {
    const transferTo = (to: string): ExecutionDTO => ({
      executionType: "SIGNATURE",
      quoteToken: "qt-2",
      submit: { url: "https://app.ravn.exchange/api/v1/submit-signature" },
      typedData: {
        domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: { from: USER, to, value: "1000000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"0".repeat(64)}` },
      },
    });
    refuses(transferTo(HINKAL), intent, /pays an address RAVN doesn't route through/);
    expect(() => checkExecution(transferTo("0x4cd00e387622c35bddb9b4c962c136462338bc31"), intent)).not.toThrow();
  });
});

// The API, as executeAndTrack calls it: each /execute answers the next of `executes` (a function:
// called as the answer is sent).
function api(executes: unknown[], recovers: unknown[] = []) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const path = new URL(url).pathname.split("/").pop();
    const next = path === "execute" ? executes.shift() : path === "recover" ? recovers.shift() : { status: "success", venue: "hinkal" };
    const data = typeof next === "function" ? next() : next;
    return { ok: true, status: 200, json: async () => ({ data }) };
  });
}
const executeCalls = (fetchImpl: ReturnType<typeof api>) =>
  fetchImpl.mock.calls
    .filter(([url]) => url.endsWith("/execute"))
    .map(([, init]) => ({ body: JSON.parse(String(init!.body)), key: (init!.headers as Record<string, string>)["Idempotency-Key"] }));
const receipt = (hash: string) => ({ status: "success" as const, transactionHash: hash });
const APPROVAL_HASH = `0x${"a".repeat(64)}`;
const DEPOSIT_HASH = `0x${"d".repeat(64)}`;
const FEE_HASH = `0x${"f".repeat(64)}`;

function wallet(steps: string[]) {
  return {
    signMessage: vi.fn(async (message: string) => {
      steps.push(`signMessage:${message.split("\n")[0]}`);
      return "0x5e55" as const;
    }),
    switchChain: vi.fn(async (chainId: number) => {
      steps.push(`switchChain:${chainId}`);
    }),
    signTypedData: vi.fn(async (typed: Record<string, unknown>) => {
      steps.push(`signTypedData:${typed.primaryType}`);
      return "0x0de4" as const;
    }),
    sendTransaction: vi.fn(async (tx: { to?: string; data?: string }) => {
      const hash = tx.to === HINKAL ? DEPOSIT_HASH : tx.data?.startsWith("0x095ea7b3") ? APPROVAL_HASH : FEE_HASH;
      steps.push(`send:${hash.slice(0, 3)}`);
      return hash;
    }),
    waitForReceipt: vi.fn(async (hash: string) => receipt(hash)),
  };
}

describe("executeAndTrack: AUTHORIZE (Hinkal)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("signs each step, answers it with execute, then sends the deposit and tracks it", async () => {
    const fetchImpl = api([session(), placing(order()), tokenSell()]);
    const client = new RavnClient({ fetch: fetchImpl as unknown as typeof fetch });
    const steps: string[] = [];
    const result = await executeAndTrack(client, { quoteToken: "qt-1", destinationAddress: DEST }, wallet(steps), { intent, pollIntervalMs: 0 });

    expect(steps).toEqual([
      "signMessage:Authorize Hinkal session",
      "switchChain:8453",
      "signTypedData:PrivateSendBridge",
      "send:0xa",
      "send:0xd",
      "send:0xf",
    ]);
    const calls = executeCalls(fetchImpl);
    expect(calls.map((c) => c.body)).toEqual([
      { quoteToken: "qt-1", destinationAddress: DEST },
      { quoteToken: "qt-1", destinationAddress: DEST, authorization: "step-1", signature: "0x5e55" },
      { quoteToken: "qt-1", destinationAddress: DEST, authorization: "step-2", signature: "0x0de4" },
    ]);
    // Each answer an execute of its own: a repeat with the first key would get the first answer back.
    expect(new Set(calls.map((c) => c.key)).size).toBe(3);
    expect(result).toMatchObject({ quoteToken: "qt-2", approvalTxHash: APPROVAL_HASH, txHash: DEPOSIT_HASH, feeTxHash: FEE_HASH, statusRef: DEPOSIT_HASH });
    expect(result.execution.executionType).toBe("TRANSACTION");
    expect(result.finalStatus).toEqual({ status: "success", venue: "hinkal" });
  });

  it("asks the wallet for nothing it doesn't need: no switchChain handler, the wallet signs on its chain", async () => {
    const fetchImpl = api([placing(order()), tokenSell()]);
    const client = new RavnClient({ fetch: fetchImpl as unknown as typeof fetch });
    const steps: string[] = [];
    const { switchChain: _, ...handlers } = wallet(steps);
    await executeAndTrack(client, { quoteToken: "qt-1" }, handlers, { intent, pollIntervalMs: 0 });
    expect(steps[0]).toBe("signTypedData:PrivateSendBridge");
  });

  it("refuses an AUTHORIZE the check doesn't accept before the wallet sees it", async () => {
    const client = new RavnClient({ fetch: api([session(`${SESSION}\nThis signature can also be used to submit transactions.`)]) as unknown as typeof fetch });
    const handlers = wallet([]);
    await expect(executeAndTrack(client, { quoteToken: "qt-1" }, handlers, { intent })).rejects.toThrow(UnsafeExecutionError);
    expect(handlers.signMessage).not.toHaveBeenCalled();
  });

  it("refuses an order paying someone else before the wallet sees it, on the step it comes back on", async () => {
    const t = order();
    t.message.recipients[0].recipient = ATTACKER;
    const client = new RavnClient({ fetch: api([session(), placing(t)]) as unknown as typeof fetch });
    const handlers = wallet([]);
    await expect(executeAndTrack(client, { quoteToken: "qt-1" }, handlers, { intent })).rejects.toThrow(/pays someone other than the destination/);
    expect(handlers.signMessage).toHaveBeenCalledOnce();
    expect(handlers.signTypedData).not.toHaveBeenCalled();
  });

  it("refuses an authorization already past expiresAt, signing nothing", async () => {
    const fetchImpl = api([{ ...session(), expiresAt: new Date(Date.now() - 1).toISOString() }]);
    const handlers = wallet([]);
    await expect(executeAndTrack(new RavnClient({ fetch: fetchImpl as unknown as typeof fetch }), { quoteToken: "qt-1" }, handlers, { intent })).rejects.toThrow(/expired before it was signed/);
    expect(handlers.signMessage).not.toHaveBeenCalled();
    const unreadable = api([{ ...session(), expiresAt: "soon" }]);
    await expect(executeAndTrack(new RavnClient({ fetch: unreadable as unknown as typeof fetch }), { quoteToken: "qt-1" }, handlers, { intent })).rejects.toThrow(/expired/);
  });

  it("doesn't answer an authorization that expired while the wallet was signing it", async () => {
    const fetchImpl = api([session(), placing(order()), tokenSell()]);
    const handlers = wallet([]);
    const start = Date.now();
    handlers.signMessage.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + 9 * 60_000 + 1);
      return "0x5e55";
    });
    await expect(executeAndTrack(new RavnClient({ fetch: fetchImpl as unknown as typeof fetch }), { quoteToken: "qt-1" }, handlers, { intent })).rejects.toThrow(/expired/);
    expect(executeCalls(fetchImpl)).toHaveLength(1);
  });

  it("refuses without the signer a step needs", async () => {
    const client = new RavnClient({ fetch: api([session()]) as unknown as typeof fetch });
    const { signMessage: _, ...handlers } = wallet([]);
    await expect(executeAndTrack(client, { quoteToken: "qt-1" }, handlers, { intent })).rejects.toThrow(/needs signMessage/);
    const typed = new RavnClient({ fetch: api([placing(order())]) as unknown as typeof fetch });
    const { signTypedData: __, ...noTyped } = wallet([]);
    await expect(executeAndTrack(typed, { quoteToken: "qt-1" }, noTyped, { intent })).rejects.toThrow(/needs signTypedData/);
  });

  it("counts the deposit's 10 minutes from when the order step arrived (Hinkal priced the route), not from its answer", async () => {
    const start = Date.now();
    const handlers = wallet([]);
    // 3 minutes in the wallet, then 7.5 waiting on the approval: 10.5 since the route was priced.
    handlers.signTypedData.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + 3 * 60_000);
      return "0x0de4";
    });
    handlers.waitForReceipt.mockImplementation(async (hash: string) => {
      vi.spyOn(Date, "now").mockReturnValue(start + 10.5 * 60_000);
      return receipt(hash);
    });
    const client = new RavnClient({ fetch: api([placing(order()), tokenSell()]) as unknown as typeof fetch });
    const failure = await executeAndTrack(client, { quoteToken: "qt-1" }, handlers, { intent }).catch((e) => e);
    expect(failure.message).toMatch(/more than 10 minutes passed since the order was priced/);
    expect(handlers.sendTransaction).toHaveBeenCalledOnce();
  });

  it("doesn't send the deposit more than 10 minutes after the order was placed", async () => {
    const fetchImpl = api([placing(order()), tokenSell()]);
    const handlers = wallet([]);
    const start = Date.now();
    handlers.waitForReceipt.mockImplementation(async (hash: string) => {
      vi.spyOn(Date, "now").mockReturnValue(start + 10 * 60_000 + 1_000);
      return receipt(hash);
    });
    const failure = await executeAndTrack(new RavnClient({ fetch: fetchImpl as unknown as typeof fetch }), { quoteToken: "qt-1" }, handlers, { intent }).catch((e) => e);
    expect(failure).toBeInstanceOf(ExecuteAndTrackError);
    expect(failure.message).toMatch(/more than 10 minutes/);
    expect(failure.partial.approvalTxHash).toBe(APPROVAL_HASH);
    expect(handlers.sendTransaction).toHaveBeenCalledOnce();
  });

  it("spends no approval gas on a deposit already too late to send", async () => {
    const start = Date.now();
    const late = () => {
      vi.spyOn(Date, "now").mockReturnValue(start + 10 * 60_000 + 1_000);
      return tokenSell();
    };
    const handlers = wallet([]);
    const client = new RavnClient({ fetch: api([placing(order()), late]) as unknown as typeof fetch });
    await expect(executeAndTrack(client, { quoteToken: "qt-1" }, handlers, { intent })).rejects.toThrow(/more than 10 minutes/);
    expect(handlers.sendTransaction).not.toHaveBeenCalled();
  });

  it("holds the window on a batched deposit too", async () => {
    const steps: string[] = [];
    const handlers = { ...wallet(steps), sendCalls: vi.fn(async () => [APPROVAL_HASH]) };
    const start = Date.now();
    const slowRead = vi.fn(async () => {
      vi.spyOn(Date, "now").mockReturnValue(start + 10 * 60_000 + 1_000);
      return false;
    });
    const client = new RavnClient({ fetch: api([placing(order()), tokenSell()]) as unknown as typeof fetch });
    await expect(executeAndTrack(client, { quoteToken: "qt-1" }, { ...handlers, hasAllowance: slowRead }, { intent })).rejects.toThrow(/more than 10 minutes/);
    expect(handlers.sendCalls).not.toHaveBeenCalled();
  });

  it("signs one session and one order per swap, never a second of either", async () => {
    const handlers = wallet([]);
    const client = new RavnClient({ fetch: api([session(), session()]) as unknown as typeof fetch });
    await expect(executeAndTrack(client, { quoteToken: "qt-1" }, handlers, { intent })).rejects.toThrow(/second personal_sign/);
    expect(handlers.signMessage).toHaveBeenCalledOnce();
    const orders = new RavnClient({ fetch: api([placing(order()), placing(order())]) as unknown as typeof fetch });
    await expect(executeAndTrack(orders, { quoteToken: "qt-1" }, handlers, { intent })).rejects.toThrow(/second eth_signTypedData_v4/);
    expect(handlers.signTypedData).toHaveBeenCalledOnce();
  });

  it("keeps no such window on a swap that needed no authorization", async () => {
    const fetchImpl = api([tokenSell()]);
    const handlers = wallet([]);
    const start = Date.now();
    handlers.waitForReceipt.mockImplementation(async (hash: string) => {
      vi.spyOn(Date, "now").mockReturnValue(start + 60 * 60_000);
      return receipt(hash);
    });
    const result = await executeAndTrack(new RavnClient({ fetch: fetchImpl as unknown as typeof fetch }), { quoteToken: "qt-1" }, handlers, { intent, pollIntervalMs: 0 });
    expect(result.txHash).toBe(DEPOSIT_HASH);
  });
});

describe("getQuote: the AUTHORIZE opt-in", () => {
  it("sends authorizeSteps as given, streamed or not: without it RAVN leaves Hinkal out", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ data: { quoteToken: "qt-1", alternatives: [] } }) }));
    const client = new RavnClient({ fetch: fetchImpl as unknown as typeof fetch });
    const params = { ...intent, outputChainId: 42161, outputToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", confidential: true, authorizeSteps: true };
    await client.getQuote(params);
    await client.getQuoteStream(params);
    for (const [, init] of fetchImpl.mock.calls) expect(JSON.parse(String(init!.body))).toMatchObject({ confidential: true, authorizeSteps: true });
  });
});

// /v1/recover's answers, as ravn-mvp's lib/hinkal/recover builds them.
const recoveryTyped = (kind: "RecoverStuckBridgeBalance" | "WithdrawStuckUtxos", over: { chainId?: unknown; tokenAddress?: string; recipient?: string } = {}) => ({
  domain: { name: "Hinkal Enclave", chainId: 8453 } as Record<string, unknown>,
  types: {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }],
    [kind]: [
      { name: "nonce", type: "string" },
      { name: "sessionId", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "tokenAddress", type: "address" },
      { name: "recipient", type: "address" },
    ],
  } as Partial<Record<string, { name: string; type: string }[]>>,
  primaryType: kind as string,
  message: { nonce: "n-1", sessionId: "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b", chainId: 8453 as unknown, tokenAddress: USDC, recipient: USER, ...over },
});
const recoverSession = (authorization = "r-1"): RecoverDTO => ({ status: "sign", authorization, sign: { method: "personal_sign", message: SESSION }, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), step: 1 });
const recovering = (typedData: Record<string, unknown>, authorization = "r-2"): RecoverDTO => ({ status: "sign", authorization, sign: { method: "eth_signTypedData_v4", typedData }, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), step: 2 });
const done = (tokenAddress: string, authorization: string): RecoverDTO => ({ status: "done", recovered: [{ chainId: 8453, tokenAddress, amount: "1000" }], authorization });
const STATUS_REF = "0b7d1c2e-1111-4222-8333-944455556666";

describe("checkRecovery: what the paying wallet signs to get Hinkal's stuck funds back", () => {
  const refusesRecovery = (answer: RecoverDTO, message: RegExp, user = USER) => {
    expect(() => checkRecovery(answer, user)).toThrow(UnsafeExecutionError);
    expect(() => checkRecovery(answer, user)).toThrow(message);
  };

  it("accepts the session, both recoveries back to the signer, done and nothing", () => {
    expect(() => checkRecovery(recoverSession(), USER)).not.toThrow();
    expect(() => checkRecovery(recovering(recoveryTyped("RecoverStuckBridgeBalance")), USER)).not.toThrow();
    expect(() => checkRecovery(recovering(recoveryTyped("WithdrawStuckUtxos")), USER.toUpperCase().replace("0X", "0x"))).not.toThrow();
    expect(() => checkRecovery(done(USDC, "r-3"), USER)).not.toThrow();
    expect(() => checkRecovery({ status: "nothing" }, USER)).not.toThrow();
  });

  it("refuses a recovery to anyone but the signing wallet", () => {
    refusesRecovery(recovering(recoveryTyped("RecoverStuckBridgeBalance", { recipient: ATTACKER })), /someone other than the signing wallet/);
    refusesRecovery(recovering(recoveryTyped("WithdrawStuckUtxos")), /someone other than the signing wallet/, DEST);
    refusesRecovery(recovering(recoveryTyped("WithdrawStuckUtxos")), /someone other than the signing wallet/, "");
  });

  it("refuses a normal-mode session, another kind, or fields other than Hinkal's", () => {
    const normal = { ...recoverSession(), sign: { method: "personal_sign" as const, message: `${SESSION}\nThis signature can also be used to submit transactions.` } };
    refusesRecovery(normal, /can move the user's funds/);
    const withdraw = recoveryTyped("RecoverStuckBridgeBalance");
    withdraw.types.Withdraw = withdraw.types.RecoverStuckBridgeBalance;
    delete withdraw.types.RecoverStuckBridgeBalance;
    withdraw.primaryType = "Withdraw";
    refusesRecovery(recovering(withdraw), /kind this SDK doesn't recognise/);
    const asText = recoveryTyped("WithdrawStuckUtxos");
    asText.types.WithdrawStuckUtxos = asText.types.WithdrawStuckUtxos!.map((f) => (f.name === "recipient" ? { name: "recipient", type: "string" } : f));
    refusesRecovery(recovering(asText), /signs other fields than its kind's/);
    // One field whose type spells out the rest: joined, it reads as Hinkal's five.
    const joined = recoveryTyped("WithdrawStuckUtxos");
    joined.types.WithdrawStuckUtxos = [{ name: "nonce", type: "string,sessionId:string,chainId:uint256,tokenAddress:address,recipient:address" }];
    refusesRecovery(recovering(joined), /signs other fields than its kind's/);
    const rooted = recoveryTyped("WithdrawStuckUtxos");
    rooted.types.Extra = [{ name: "x", type: "uint256" }];
    refusesRecovery(recovering(rooted), /sign something other than its primaryType/);
    // A second root behind a type that isn't a string: String() would name it "null", "undefined", or
    // for an array, any struct at all.
    for (const [name, field] of [["null", { name: "x", type: null }], ["undefined", { name: "x" }], ["Other", { name: "a", type: ["Other"] }]] as const) {
      const hidden = recoveryTyped("WithdrawStuckUtxos");
      (hidden.types as Record<string, unknown>)[name] = [field];
      refusesRecovery(recovering(hidden), /sign something other than its primaryType/);
    }
    const contract = recoveryTyped("WithdrawStuckUtxos");
    contract.domain.verifyingContract = HINKAL;
    refusesRecovery(recovering(contract), /isn't for Hinkal's enclave/);
  });

  it("refuses a recovery on a chain Hinkal doesn't run on, or naming no token", () => {
    const optimism = recoveryTyped("WithdrawStuckUtxos", { chainId: 10 });
    optimism.domain.chainId = 10;
    refusesRecovery(recovering(optimism), /isn't for a chain Hinkal runs on/);
    refusesRecovery(recovering(recoveryTyped("WithdrawStuckUtxos", { chainId: 1 })), /isn't for a chain Hinkal runs on/);
    refusesRecovery(recovering(recoveryTyped("WithdrawStuckUtxos", { tokenAddress: "USDC" })), /names no token/);
    // String([USDC]) is USDC itself.
    const wrapped = recoveryTyped("WithdrawStuckUtxos");
    (wrapped.message as Record<string, unknown>).tokenAddress = [USDC];
    refusesRecovery(recovering(wrapped), /names no token/);
  });

  it("refuses an answer it doesn't know", () => {
    refusesRecovery({ status: "refunded" } as unknown as RecoverDTO, /can't check a recovery answer of status refunded/);
  });

  it("is what RavnClient.recover runs on every answer, unless the guard is off", async () => {
    const bad = recovering(recoveryTyped("RecoverStuckBridgeBalance", { recipient: ATTACKER }));
    const guarded = new RavnClient({ fetch: api([], [bad]) as unknown as typeof fetch });
    await expect(guarded.recover({ statusRef: STATUS_REF }, { userAddress: USER })).rejects.toThrow(/someone other than the signing wallet/);
    const open = new RavnClient({ guard: false, fetch: api([], [bad]) as unknown as typeof fetch });
    await expect(open.recover({ statusRef: STATUS_REF }, { userAddress: USER })).resolves.toEqual(bad);
  });
});

describe("recoverStuckFunds", () => {
  afterEach(() => vi.restoreAllMocks());
  const OTHER = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
  const recoverCalls = (fetchImpl: ReturnType<typeof api>) =>
    fetchImpl.mock.calls.filter(([url]) => url.endsWith("/recover")).map(([, init]) => JSON.parse(String(init!.body)));

  it("signs the session, then each recovery, looking again after each until nothing is left", async () => {
    const fetchImpl = api([], [
      recoverSession(),
      recovering(recoveryTyped("RecoverStuckBridgeBalance"), "r-2"),
      done(USDC, "again-1"),
      recovering(recoveryTyped("WithdrawStuckUtxos", { tokenAddress: OTHER }), "r-3"),
      done(OTHER, "again-2"),
      { status: "nothing" },
    ]);
    const steps: string[] = [];
    const { signMessage, signTypedData, switchChain } = wallet(steps);
    const result = await recoverStuckFunds(new RavnClient({ fetch: fetchImpl as unknown as typeof fetch }), { statusRef: STATUS_REF, userAddress: USER }, { signMessage, signTypedData, switchChain });
    expect(result.recovered.map((r) => r.tokenAddress)).toEqual([USDC, OTHER]);
    expect(steps).toEqual([
      "signMessage:Authorize Hinkal session",
      "switchChain:8453",
      "signTypedData:RecoverStuckBridgeBalance",
      "switchChain:8453",
      "signTypedData:WithdrawStuckUtxos",
    ]);
    expect(recoverCalls(fetchImpl)).toEqual([
      { statusRef: STATUS_REF },
      { statusRef: STATUS_REF, authorization: "r-1", signature: "0x5e55" },
      { statusRef: STATUS_REF, authorization: "r-2", signature: "0x0de4" },
      // The continuation: its authorization alone.
      { statusRef: STATUS_REF, authorization: "again-1" },
      { statusRef: STATUS_REF, authorization: "r-3", signature: "0x0de4" },
      { statusRef: STATUS_REF, authorization: "again-2" },
    ]);
  });

  it("resolves empty when nothing is stuck", async () => {
    const { signMessage, signTypedData } = wallet([]);
    const client = new RavnClient({ fetch: api([], [recoverSession(), { status: "nothing" }]) as unknown as typeof fetch });
    await expect(recoverStuckFunds(client, { statusRef: STATUS_REF, userAddress: USER }, { signMessage, signTypedData })).resolves.toEqual({ recovered: [] });
  });

  it("never signs the same recovery (kind, chain, token) twice: offered again, it stops with what came back", async () => {
    const { signMessage, signTypedData } = wallet([]);
    const twice = new RavnClient({
      fetch: api([], [recoverSession(), recovering(recoveryTyped("WithdrawStuckUtxos")), done(USDC, "a-1"), recovering(recoveryTyped("WithdrawStuckUtxos"), "r-3")]) as unknown as typeof fetch,
    });
    const result = await recoverStuckFunds(twice, { statusRef: STATUS_REF, userAddress: USER }, { signMessage, signTypedData });
    expect(result.recovered.map((r) => r.tokenAddress)).toEqual([USDC]);
    expect(signTypedData).toHaveBeenCalledOnce();
  });

  it("signs one session, recoveries on one chain only, and no more than 8", async () => {
    const { signMessage, signTypedData } = wallet([]);
    const sessions = new RavnClient({ fetch: api([], [recoverSession(), recoverSession("r-9")]) as unknown as typeof fetch });
    await expect(recoverStuckFunds(sessions, { statusRef: STATUS_REF, userAddress: USER }, { signMessage, signTypedData })).rejects.toThrow(/session a second time/);

    const other = recoveryTyped("RecoverStuckBridgeBalance", { chainId: 1 });
    other.domain.chainId = 1;
    const chains = new RavnClient({ fetch: api([], [recoverSession(), recovering(recoveryTyped("RecoverStuckBridgeBalance")), done(USDC, "a-1"), recovering(other, "r-3")]) as unknown as typeof fetch });
    signTypedData.mockClear();
    await expect(recoverStuckFunds(chains, { statusRef: STATUS_REF, userAddress: USER }, { signMessage, signTypedData })).rejects.toThrow(/on chain 1 after one on chain 8453/);
    expect(signTypedData).toHaveBeenCalledOnce();

    const token = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}`;
    const many: RecoverDTO[] = [recoverSession()];
    for (let i = 0; i < 9; i++) many.push(recovering(recoveryTyped("WithdrawStuckUtxos", { tokenAddress: token(i) }), `r-${i}`), done(token(i), `a-${i}`));
    signTypedData.mockClear();
    await expect(recoverStuckFunds(new RavnClient({ fetch: api([], many) as unknown as typeof fetch }), { statusRef: STATUS_REF, userAddress: USER }, { signMessage, signTypedData })).rejects.toThrow(/more than 8 recoveries/);
    expect(signTypedData).toHaveBeenCalledTimes(8);
  });

  it("refuses a done that answers no recovery, and a step past its expiresAt", async () => {
    const { signMessage, signTypedData } = wallet([]);
    const early = new RavnClient({ fetch: api([], [recoverSession(), done(USDC, "a-1")]) as unknown as typeof fetch });
    await expect(recoverStuckFunds(early, { statusRef: STATUS_REF, userAddress: USER }, { signMessage, signTypedData })).rejects.toThrow(/done without a recovery/);
    const stale = new RavnClient({ fetch: api([], [{ ...recoverSession(), expiresAt: new Date(Date.now() - 1).toISOString() }]) as unknown as typeof fetch });
    signMessage.mockClear();
    await expect(recoverStuckFunds(stale, { statusRef: STATUS_REF, userAddress: USER }, { signMessage, signTypedData })).rejects.toThrow(/expired/);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("refuses a recovery to another wallet before the wallet sees it", async () => {
    const { signMessage, signTypedData } = wallet([]);
    const client = new RavnClient({ fetch: api([], [recoverSession(), recovering(recoveryTyped("RecoverStuckBridgeBalance", { recipient: ATTACKER }))]) as unknown as typeof fetch });
    await expect(recoverStuckFunds(client, { statusRef: STATUS_REF, userAddress: USER }, { signMessage, signTypedData })).rejects.toThrow(UnsafeExecutionError);
    expect(signTypedData).not.toHaveBeenCalled();
  });
});
