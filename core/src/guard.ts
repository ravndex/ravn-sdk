import { UnsafeExecutionError } from "./types";
import type { ApprovalDTO, AuthorizeDTO, DepositFeeDTO, ExecutionDTO, RecoverDTO } from "./types";
import { COW_SETTLEMENT, HINKAL, HINKAL_CHAINS, KNOWN_CONTRACTS, PERMIT2, RAVN_FEE_WALLETS, ROUTE_ENTRY, separateSpender, signatureGatedSpenders, WETH_FEE_MINTERS } from "./guard-contracts";
import { checkBitcoinPsbt } from "./guard-bitcoin";
import { checkSolanaSimulation, checkSolanaTransaction } from "./guard-solana";

/**
 * What your user asked to swap, from your own code, never from RAVN's answer: the guard holds
 * everything RAVN hands back to it. RavnClient remembers it for every quote it fetched (the quote and
 * its alternatives), so you only pass it to execute() for a quoteToken this client didn't fetch.
 */
export interface SwapIntent {
  inputChainId: number;
  /** As quoted: an EVM token address (native coin: 0xEeee…EEeE), a Solana mint, or "native" for BTC. */
  inputToken: string;
  /** Base units. */
  inputAmount: string;
  /** The wallet that signs: change, refunds and order owners must be it. */
  userAddress: string;
  destinationAddress?: string;
  /** The quote was asked for with `sandbox: true`: only then is an execution marked sandbox left unchecked. */
  sandbox?: boolean;
}

export interface GuardOptions {
  /**
   * Extra contracts to accept as transaction targets and spenders, per chain id: for a venue that
   * moved to a new contract before your SDK version knew it. Only add addresses you have checked
   * belong to that venue.
   */
  allowContracts?: Record<number, string[]>;
  /**
   * Your Solana RPC's URL (any provider on Agave 2.3+: Helius, Triton, QuickNode, …). With it, every
   * Solana transaction is also simulated there before execute() hands it back, and refused unless
   * every transfer it makes out of the user's accounts stays within the swap (checkSolanaSimulation;
   * the README says what that covers). That reads what a venue program's own instructions do, which
   * the check otherwise can't. One RPC call (~150–400 ms) per Solana execute; refuses when the
   * simulation can't run or fails (a stale quote: fetch a new one). Sent through the client's fetch.
   */
  solanaRpcUrl?: string;
}

/** The largest fee RAVN's API lets any key set (100 bps), as a share of the input. */
const MAX_FEE_BPS = 100n;
const NATIVE_EVM = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BITCOIN_CHAIN_ID = -1;
const SOLANA_CHAIN_ID = -2;

const SEL = {
  approve: "0x095ea7b3",
  transfer: "0xa9059cbb",
  /** WETH9-style depositTo(address): wraps msg.value straight to the recipient (RAVN's coin fee on Robinhood Chain, Arbitrum). */
  depositTo: "0xb760faf9",
  /** 0x AllowanceHolder exec(operator, token, amount, target, data). */
  allowanceHolderExec: "0x2213bc0b",
  /** Hinkal.sol prooflessDeposit(address[] tokens, uint256[] amounts, (uint256,uint256,uint256,uint256,uint256)[], bytes[], bool, string). */
  prooflessDeposit: "0xbb3b5d78",
  /** RouteEntry swap((tokenIn, tokenOut, amountIn, minOut, recipient, deadline, feeBps, partner, partnerFeeBps), steps[], bytes). */
  routeSwap: "0x16c7ad17",
};

// What a read-only (EIP-712-mode) Hinkal session's personal_sign reads. Normal mode adds
// HINKAL_NORMAL_MODE, and its session key can move the user's Hinkal funds.
const HINKAL_SESSION = /^Authorize Hinkal session\nSession ID: [0-9a-f-]{36}\nPublic Key: 0[23][0-9a-f]{64}$/;
const HINKAL_NORMAL_MODE = "This signature can also be used to submit transactions.";

const lower = (s: unknown): string => (typeof s === "string" ? s.toLowerCase() : "");
// A non-negative whole number: a decimal or 0x-hex string, or a safe non-negative JS integer.
const big = (v: unknown, what: string): bigint => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(v)) return BigInt(v);
  throw new UnsafeExecutionError(`${what} isn't a whole number`, { value: v });
};
// 32-byte ABI word i of calldata after its 4-byte selector, as hex without 0x.
const word = (data: string, i: number): string => {
  const w = data.slice(10 + 64 * i, 74 + 64 * i);
  if (w.length !== 64) throw new UnsafeExecutionError("Calldata is shorter than its function's arguments", { data: data.slice(0, 10) });
  return w;
};
const wordAddress = (data: string, i: number): string => {
  const w = word(data, i);
  if (!/^0{24}/.test(w)) throw new UnsafeExecutionError("Calldata argument isn't an address", { data: data.slice(0, 10) });
  return `0x${w.slice(24)}`.toLowerCase();
};
const wordUint = (data: string, i: number): bigint => BigInt(`0x${word(data, i)}`);

interface Ctx {
  chainId: number;
  token: string;
  native: boolean;
  amount: bigint;
  feeCap: bigint;
  user: string;
  destination: string;
  known: Set<string>;
  /** Permit2 and CoW's vault relayer: may be approved beyond the amount (see signatureGatedSpenders). */
  gated: Set<string>;
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new UnsafeExecutionError(message, details);
}

// What a token must look like for the check to hold it: never a symbol, which RAVN resolves itself.
const TOKEN_FORMAT: Record<string, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  [SOLANA_CHAIN_ID]: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  [BITCOIN_CHAIN_ID]: /^native$/,
};

function context(intent: SwapIntent, options: GuardOptions): Ctx {
  const chainId = intent.inputChainId;
  const amount = big(intent.inputAmount, "The swap's input amount");
  if (amount <= 0n) fail("The swap's input amount must be positive");
  if (!(TOKEN_FORMAT[chainId] ?? TOKEN_FORMAT.evm).test(String(intent.inputToken))) {
    fail("The quote's input token isn't an address: quote with token addresses (not symbols) so execute() can check what comes back", { inputToken: intent.inputToken });
  }
  const known = new Set<string>([...(KNOWN_CONTRACTS[chainId] ?? []), ...(options.allowContracts?.[chainId] ?? [])].map(lower));
  return {
    chainId,
    token: lower(intent.inputToken),
    native: lower(intent.inputToken) === NATIVE_EVM,
    amount,
    feeCap: (amount * MAX_FEE_BPS) / 10_000n,
    user: lower(intent.userAddress),
    destination: lower(intent.destinationAddress ?? intent.userAddress),
    known,
    gated: signatureGatedSpenders(chainId),
  };
}

// A chain id, when given, must be the swap's, as a number (a wallet may read "8453" as hex, or skip
// it); `required`: it must be given (an EVM transaction without one goes out on whatever chain the
// wallet is on, in that chain's coin). Typed data's domain may carry it as a decimal string.
const sameChain = (ctx: Ctx, chainId: unknown, what: string, required = false) => {
  if (chainId === undefined || chainId === null) {
    if (required) fail(`${what} names no chain`);
    return;
  }
  if (typeof chainId !== "number") fail(`${what} gives its chain as ${typeof chainId}, not a number`, { chainId });
  if (chainId !== ctx.chainId) fail(`${what} is for chain ${chainId}, not the swap's chain ${ctx.chainId}`, { chainId });
};

/** RAVN's fee as the execution states it: to RAVN's own wallet on that chain, at most 1% of the input. */
function checkFeeTerms(ctx: Ctx, fee: DepositFeeDTO, wallet: string | undefined): bigint {
  if (!wallet || lower(fee.address) !== lower(wallet)) fail("The fee doesn't go to RAVN's fee wallet", { address: fee.address });
  sameChain(ctx, fee.chainId, "The fee");
  const amount = big(fee.amount, "The fee");
  if (amount > ctx.feeCap) fail("The fee is more than 1% of the swap", { amount: fee.amount });
  return amount;
}

type Call = { to?: string; data?: string; value?: string; chainId?: number; gasLimit?: string };

/**
 * Checks one EVM call in its role. Returns the native coin it sends and the input token it commits:
 * approved (beyond a signature-gated spender), pulled by 0x or Route, transferred as RAVN's fee or deposited.
 * `limit`: the most a fee or deposit call may move.
 */
function classifyEvmCall(
  ctx: Ctx,
  call: Call,
  role: "approval" | "fee" | "swap" | "deposit",
  limit = 0n,
  depositTo?: string
): { value: bigint; tokens: bigint } {
  sameChain(ctx, call.chainId, "A transaction", true);
  const to = lower(call.to);
  const data = lower(call.data ?? "0x");
  const value = big(call.value ?? "0", "A transaction's value");
  if (!/^0x[0-9a-f]{40}$/.test(to)) fail("A transaction has no valid recipient", { to: call.to });
  if (!/^0x([0-9a-f]{2})*$/.test(data)) fail("A transaction's data isn't hex", { to });
  const sel = data.slice(0, 10);
  const feeWallet = lower(RAVN_FEE_WALLETS.evm);

  if (role === "approval") {
    // approve(spender, amount) on the input token only, to a venue contract RAVN routes through;
    // more than the swap only for a spender that moves funds solely against the user's own
    // signature (Permit2, CoW's vault relayer).
    if (ctx.native) fail("An approval was asked for a swap paying in the native coin");
    if (to !== ctx.token) fail("An approval is for a token other than the one being swapped", { to });
    if (sel !== SEL.approve || data.length !== 138) fail("The approval isn't a plain approve()", { to, selector: sel });
    if (value !== 0n) fail("The approval sends value", { to });
    const spender = wordAddress(data, 0);
    const approved = wordUint(data, 1);
    if (!ctx.known.has(spender) && !ctx.gated.has(spender)) fail("The approval names a spender RAVN doesn't route through", { spender });
    if (approved > ctx.amount && !ctx.gated.has(spender)) {
      fail("The approval is for more than the swap's amount", { spender, amount: approved.toString() });
    }
    return { value: 0n, tokens: ctx.gated.has(spender) ? 0n : approved };
  }

  if (role === "fee") {
    // To RAVN's fee wallet only: the coin itself (a short tag as data), the input token's
    // transfer(wallet, fee) with a trailing tag, or WETH minted to the wallet (depositTo).
    if (to === feeWallet) {
      if (data.length > 2 + 64) fail("The fee payment carries more than a tag", { to });
      if (!ctx.native) fail("A coin fee was asked on a token swap", { to });
      if (value > limit) fail("The fee payment is more than the fee", { value: value.toString() });
      return { value, tokens: 0n };
    }
    if (to === ctx.token && sel === SEL.transfer) {
      if (wordAddress(data, 0) !== feeWallet) fail("The fee transfer isn't to RAVN's fee wallet", { to: wordAddress(data, 0) });
      if (wordUint(data, 1) > limit) fail("The fee payment is more than the fee", { amount: wordUint(data, 1).toString() });
      if (data.length > 138 + 64) fail("The fee transfer carries more than a tag", { to });
      if (value !== 0n) fail("The fee transfer sends value", { to });
      return { value: 0n, tokens: wordUint(data, 1) };
    }
    if (WETH_FEE_MINTERS[ctx.chainId] && to === lower(WETH_FEE_MINTERS[ctx.chainId]) && sel === SEL.depositTo) {
      if (!ctx.native) fail("A coin fee was asked on a token swap", { to });
      if (wordAddress(data, 0) !== feeWallet) fail("The fee isn't minted to RAVN's fee wallet", { to: wordAddress(data, 0) });
      if (data.length > 74 + 64) fail("The fee payment carries more than a tag", { to });
      if (value > limit) fail("The fee payment is more than the fee", { value: value.toString() });
      return { value, tokens: 0n };
    }
    fail("The fee payment isn't a payment to RAVN's fee wallet", { to, selector: sel });
  }

  if (role === "deposit") {
    // The deposit itself: the coin to the deposit address, or the input token's transfer to it.
    let deposited: bigint;
    if (ctx.native) {
      if (to !== depositTo || data !== "0x") fail("The deposit isn't a plain payment to the deposit address", { to });
      deposited = value;
    } else {
      if (to !== ctx.token || sel !== SEL.transfer || data.length !== 138 || value !== 0n) {
        fail("The deposit isn't a transfer of the swapped token", { to, selector: sel });
      }
      if (wordAddress(data, 0) !== depositTo) fail("The deposit transfer isn't to the deposit address", { to: wordAddress(data, 0) });
      deposited = wordUint(data, 1);
    }
    if (deposited > limit) fail("The deposit sends more than the deposit amount", { amount: deposited.toString() });
    return ctx.native ? { value: deposited, tokens: 0n } : { value: 0n, tokens: deposited };
  }

  // The swap: a venue contract RAVN routes through, never a token or RAVN's own wallet.
  if (!ctx.known.has(to)) fail("The swap goes to a contract RAVN doesn't route through", { to });
  let pulled = 0n;
  if (to === lower(HINKAL)) {
    // Hinkal's deposit, its only call RAVN routes through: the input token alone (the coin as the
    // zero address), at most the swap's amount. Hinkal pulls a token with transferFrom, so this
    // holds where an allowance the user already gave Hinkal stands in for the approval.
    if (sel !== SEL.prooflessDeposit) fail("The call to Hinkal isn't a deposit", { selector: sel });
    const single = (arg: number): number => {
      const offset = wordUint(data, arg);
      if (offset % 32n !== 0n) fail("Hinkal's deposit calldata isn't ABI-encoded");
      const at = Number(offset / 32n);
      if (wordUint(data, at) !== 1n) fail("The Hinkal deposit isn't for exactly one token");
      return at + 1;
    };
    const token = wordAddress(data, single(0));
    pulled = wordUint(data, single(1));
    if (token !== (ctx.native ? ZERO_ADDRESS : ctx.token)) fail("The Hinkal deposit is for a token other than the one being swapped", { token });
    if (pulled > ctx.amount) fail("The Hinkal deposit is for more than the swap's amount", { amount: pulled.toString() });
  } else if (to === lower(ROUTE_ENTRY)) {
    // Route's swap, its only call RAVN routes through: RouteEntry pulls the order's amountIn of tokenIn
    // (the coin as the zero address) from the sender, so a standing allowance to it is held to the swap.
    if (sel !== SEL.routeSwap) fail("The call to Route isn't a swap", { selector: sel });
    const token = wordAddress(data, 0);
    pulled = wordUint(data, 2);
    if (token !== (ctx.native ? ZERO_ADDRESS : ctx.token)) fail("The swap takes a token other than the one being swapped", { token });
    if (pulled > ctx.amount) fail("The swap takes more than the swap's amount", { amount: pulled.toString() });
  } else if (sel === SEL.allowanceHolderExec) {
    // 0x pulls exec's `amount` of `token` from the sender: within the swap, whatever the user
    // allowed AllowanceHolder before.
    const token = wordAddress(data, 1);
    pulled = wordUint(data, 2);
    // A native sell names the coin as the zero address (or 0xEeee…).
    if (token !== ctx.token && !(ctx.native && (token === NATIVE_EVM || token === ZERO_ADDRESS))) {
      fail("The swap takes a token other than the one being swapped", { token });
    }
    if (pulled > ctx.amount) fail("The swap takes more than the swap's amount", { amount: pulled.toString() });
  }
  if (!ctx.native && value !== 0n) fail("A token swap sends the native coin too", { to, value: value.toString() });
  return { value, tokens: ctx.native ? 0n : pulled };
}

// The approval's calldata, and the fields that describe it, which an integrator may build its own
// approve() from: they must say the same thing.
function checkApproval(ctx: Ctx, approval: ApprovalDTO): bigint {
  sameChain(ctx, approval.chainId, "The approval", true);
  if (approval.reset) {
    classifyEvmCall(ctx, { ...approval.reset, chainId: approval.chainId }, "approval");
    if (wordUint(lower(approval.reset.data), 1) !== 0n) fail("The approval reset isn't to zero");
  }
  const { tokens } = classifyEvmCall(ctx, approval, "approval");
  const data = lower(approval.data);
  const spender = wordAddress(data, 0);
  if (approval.spender !== undefined && lower(approval.spender) !== spender) {
    fail("The approval's spender isn't the one its calldata approves", { spender: approval.spender, approves: spender });
  }
  if (big(approval.amount, "The approval amount") !== wordUint(data, 1)) {
    fail("The approval's amount isn't the one its calldata approves", { amount: approval.amount });
  }
  if (approval.unlimitedRecommended && !ctx.gated.has(spender)) {
    fail("An unlimited approval is recommended for a spender that doesn't need the user's signature for each pull", { spender });
  }
  return tokens;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * What a wallet signs is the struct `types` makes the root, whatever `primaryType` says: ethers'
 * signTypedData(domain, types, value) works it out from `types` alone. So `primaryType` must be the
 * one struct no other references; its fields are then what the verifier (the token, Permit2, CoW,
 * Hinkal) rebuilds for itself, or the signature is no good there.
 */
function soleRoot(typed: Record<string, unknown>) {
  const types = isRecord(typed.types) ? typed.types : fail("The signature request names no types");
  const structs = Object.keys(types).filter((name) => name !== "EIP712Domain");
  // Only a string type can name a struct: String() would read a missing or null one as a struct
  // called "undefined" or "null".
  const used = new Set(
    structs.flatMap((name) =>
      (Array.isArray(types[name]) ? (types[name] as unknown[]) : []).flatMap((f) => (isRecord(f) && typeof f.type === "string" ? [f.type.replace(/(\[\d*\])+$/, "")] : []))
    )
  );
  const roots = structs.filter((name) => !used.has(name));
  if (roots.length !== 1 || roots[0] !== typed.primaryType) {
    fail("The signature request's types sign something other than its primaryType", { primaryType: typed.primaryType, roots });
  }
}

/**
 * For a kind the token itself verifies, the standard's own fields, as signed: a token's struct of
 * the same name can sign others (DAI's Permit: holder, expiry, allowed: an unlimited allowance),
 * which the check reads past. CoW, Permit2 and Hinkal fix their own field lists.
 */
function signsExactly(typed: Record<string, unknown>, fields: string[]) {
  const listed = (typed.types as Record<string, unknown>)[String(typed.primaryType)];
  const signed = Array.isArray(listed) ? (listed as unknown[]) : [];
  // Field by field, name and type each: a joined string would take one field whose type is
  // "string,sessionId:string,…" for the whole list.
  const exact =
    signed.length === fields.length &&
    fields.every((field, i) => {
      const f = signed[i];
      const [name, type] = field.split(":");
      return isRecord(f) && f.name === name && f.type === type;
    });
  if (!exact) {
    const shown = signed.map((f) => (isRecord(f) ? `${String(f.name)}:${String(f.type)}` : ""));
    fail("The signature request signs other fields than its kind's", { primaryType: typed.primaryType, signed: shown });
  }
}

/**
 * Signatures RAVN asks for, by kind: each bounded to the input token and amount. A kind not listed
 * here is refused: a signature can grant anything a transaction can.
 */
function checkTypedData(ctx: Ctx, typed: unknown) {
  if (!isRecord(typed)) fail("The signature request isn't typed data");
  soleRoot(typed);
  const domain = isRecord(typed.domain) ? typed.domain : {};
  const message = isRecord(typed.message) ? typed.message : {};
  const primaryType = typed.primaryType;
  const verifying = lower(domain.verifyingContract);
  if (domain.chainId === undefined || domain.chainId === null) fail("The signature request names no chain");
  const domainChain = typeof domain.chainId === "string" && /^(\d{1,15}|0x[0-9a-fA-F]{1,12})$/.test(domain.chainId) ? Number(domain.chainId) : domain.chainId;
  sameChain(ctx, domainChain, "The signature request");

  if (!/^0x[0-9a-f]{40}$/.test(verifying)) fail("The signature request names no contract", { verifyingContract: domain.verifyingContract });

  // CoW order: sells the input token, at most the amount, paying the user (or their destination).
  const cow = COW_SETTLEMENT[ctx.chainId];
  if (primaryType === "Order" && cow && verifying === lower(cow)) {
    if (lower(message.sellToken) !== ctx.token) fail("The order sells a token other than the one being swapped", { sellToken: message.sellToken });
    const sold = big(message.sellAmount, "The order's sell amount") + big(message.feeAmount ?? "0", "The order's fee");
    if (sold > ctx.amount) fail("The order sells more than the swap's amount", { sellAmount: sold.toString() });
    const receiver = lower(message.receiver ?? ZERO_ADDRESS);
    if (receiver !== ZERO_ADDRESS && receiver !== ctx.user && receiver !== ctx.destination) {
      fail("The order pays someone other than the user", { receiver });
    }
    return;
  }

  // Permit2 one-time transfer: the input token, at most the amount. The spender may take exactly
  // that once, so it needn't be one RAVN knows (0x's settlement contracts change).
  const permit2 = PERMIT2[ctx.chainId];
  if (permit2 && verifying === lower(permit2) && (primaryType === "PermitTransferFrom" || primaryType === "PermitWitnessTransferFrom")) {
    const permitted = isRecord(message.permitted) ? message.permitted : fail("The Permit2 transfer has no single token");
    if (lower(permitted.token) !== ctx.token) fail("The Permit2 transfer is for another token", { token: permitted.token });
    if (big(permitted.amount, "The Permit2 amount") > ctx.amount) fail("The Permit2 transfer is for more than the swap's amount", { amount: permitted.amount });
    return;
  }

  // The token's own permit (EIP-2612): an allowance like approve(), so the same rules.
  if (primaryType === "Permit" && verifying === ctx.token) {
    signsExactly(typed, ["owner:address", "spender:address", "value:uint256", "nonce:uint256", "deadline:uint256"]);
    if (lower(message.owner) !== ctx.user) fail("The permit is for another wallet", { owner: message.owner });
    const spender = lower(message.spender);
    if (!ctx.known.has(spender) && !ctx.gated.has(spender)) fail("The permit names a spender RAVN doesn't route through", { spender });
    if (big(message.value, "The permit amount") > ctx.amount && !ctx.gated.has(spender)) {
      fail("The permit is for more than the swap's amount", { spender, value: message.value });
    }
    return;
  }

  // EIP-3009 (USDC and others): moves `value` once, from the user, to `to`.
  if ((primaryType === "ReceiveWithAuthorization" || primaryType === "TransferWithAuthorization") && verifying === ctx.token) {
    signsExactly(typed, ["from:address", "to:address", "value:uint256", "validAfter:uint256", "validBefore:uint256", "nonce:bytes32"]);
    if (lower(message.from) !== ctx.user) fail("The authorization moves another wallet's funds", { from: message.from });
    if (big(message.value, "The authorization amount") > ctx.amount) fail("The authorization is for more than the swap's amount", { value: message.value });
    if (primaryType === "TransferWithAuthorization" && !ctx.known.has(lower(message.to))) {
      fail("The authorization pays an address RAVN doesn't route through", { to: message.to });
    }
    return;
  }

  fail("RAVN asked for a signature of a kind this SDK doesn't recognise", { primaryType, verifyingContract: domain.verifyingContract });
}

// EVM addresses compare in any case, others (a Solana payout) exactly.
const sameAddress = (a: unknown, b: string): boolean =>
  typeof a === "string" && (/^0x[0-9a-fA-F]{40}$/.test(b) ? lower(a) === lower(b) : a === b);

/**
 * An AUTHORIZE (Hinkal) moves nothing by itself, but each signature could if it were another. The
 * personal_sign must open a read-only Hinkal session. The typed data places one PrivateSendBridge
 * order, which Hinkal pays from the deposit made for it: the input token on the input chain, at
 * most the input amount, to the one recipient quoted. Hinkal holds the
 * order's route (`quote`) to that recipient by name, but runs its bridge call as given, which can't
 * be read here: as with any venue, what pays out once funds are inside isn't checked.
 */
/** What a Hinkal step asks to sign: a personal_sign (`session`), or typed data for Hinkal's enclave. */
function hinkalSign(sign: unknown): { session: true } | { session: false; typed: Record<string, unknown>; domain: Record<string, unknown>; message: Record<string, unknown> } {
  if (!isRecord(sign)) fail("The authorization asks for nothing to sign");
  if (sign.method === "personal_sign") {
    // Every Hinkal flow starts with this: a read-only session, never normal mode's.
    const message = typeof sign.message === "string" ? sign.message : "";
    if (message.includes(HINKAL_NORMAL_MODE)) fail("The message would open a Hinkal session that can move the user's funds");
    if (!HINKAL_SESSION.test(message)) fail("The message to sign isn't a read-only Hinkal session", { message: message.slice(0, 300) });
    return { session: true };
  }
  if (sign.method !== "eth_signTypedData_v4") fail("RAVN asked for a signature of a kind this SDK doesn't recognise", { method: sign.method });
  const typed = isRecord(sign.typedData) ? sign.typedData : fail("The authorization's typed data is missing");
  soleRoot(typed);
  const domain = isRecord(typed.domain) ? typed.domain : {};
  // Hinkal's domain names no contract: a field more would make the signature good somewhere else.
  if (domain.name !== "Hinkal Enclave" || Object.keys(domain).some((k) => k !== "name" && k !== "chainId")) {
    fail("The signature request isn't for Hinkal's enclave", { domain });
  }
  return { session: false, typed, domain, message: isRecord(typed.message) ? typed.message : {} };
}

function checkAuthorize(ctx: Ctx, execution: AuthorizeDTO, intent: SwapIntent) {
  if (!HINKAL_CHAINS.includes(ctx.chainId)) fail(`This SDK version doesn't know Hinkal on chain ${ctx.chainId}: update @ravnexchange/sdk`);
  const step = hinkalSign(execution.sign);
  if (step.session) return;
  const { typed, domain, message } = step;
  sameChain(ctx, domain.chainId, "The signature request", true);
  if (typed.primaryType !== "PrivateSendBridge") fail("RAVN asked for a signature of a kind this SDK doesn't recognise", { primaryType: typed.primaryType });
  sameChain(ctx, message.chainId, "The order", true);
  if (lower(message.tokenAddress) !== (ctx.native ? ZERO_ADDRESS : ctx.token)) {
    fail("The order is for a token other than the one being swapped", { tokenAddress: message.tokenAddress });
  }
  const recipients = Array.isArray(message.recipients) ? message.recipients : [];
  const only: unknown = recipients[0];
  if (recipients.length !== 1 || !isRecord(only)) fail("The order doesn't pay exactly one recipient", { count: recipients.length });
  if (big(only.amount, "The order's amount") > ctx.amount) fail("The order sends more than the swap's amount", { amount: only.amount });
  // No destination asked: the user's own wallet, as for any order.
  if (!sameAddress(only.recipient, intent.destinationAddress ?? intent.userAddress)) {
    fail("The order pays someone other than the destination address", { recipient: only.recipient });
  }
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Hinkal's own field list for both recoveries (its enclave rebuilds it): `recipient` is signed.
const RECOVERY_FIELDS = ["nonce:string", "sessionId:string", "chainId:uint256", "tokenAddress:address", "recipient:address"];

/**
 * Throws UnsafeExecutionError unless a /v1/recover answer is one the wallet that paid for the swap,
 * `userAddress`, may sign: a read-only Hinkal session, or a recovery (RecoverStuckBridgeBalance /
 * WithdrawStuckUtxos) on a chain Hinkal runs on that sends a token back to that same wallet, and
 * nowhere else. RavnClient.recover runs it on every answer.
 */
export function checkRecovery(answer: RecoverDTO, userAddress: string): void {
  if (!isRecord(answer as unknown)) fail("RAVN's answer isn't a recovery");
  if (answer.status === "nothing" || answer.status === "done") return;
  if (answer.status !== "sign") fail(`This SDK version can't check a recovery answer of status ${(answer as { status: unknown }).status}: update @ravnexchange/sdk`);
  const step = hinkalSign(answer.sign);
  if (step.session) return;
  const { typed, domain, message } = step;
  if (typed.primaryType !== "RecoverStuckBridgeBalance" && typed.primaryType !== "WithdrawStuckUtxos") {
    fail("RAVN asked for a signature of a kind this SDK doesn't recognise", { primaryType: typed.primaryType });
  }
  signsExactly(typed, RECOVERY_FIELDS);
  if (typeof domain.chainId !== "number" || !HINKAL_CHAINS.includes(domain.chainId) || message.chainId !== domain.chainId) {
    fail("The recovery isn't for a chain Hinkal runs on", { chainId: domain.chainId, messageChainId: message.chainId });
  }
  // A string: String() of a one-element array is that element.
  if (typeof message.tokenAddress !== "string" || !EVM_ADDRESS.test(message.tokenAddress)) {
    fail("The recovery names no token", { tokenAddress: message.tokenAddress });
  }
  if (!EVM_ADDRESS.test(userAddress) || lower(message.recipient) !== lower(userAddress)) {
    fail("The recovery sends the funds to someone other than the signing wallet", { recipient: message.recipient });
  }
}

/**
 * Throws UnsafeExecutionError unless every transaction, signature and deposit in `execution` stays
 * within what `intent` asked: the input token on the input chain, no more than the input amount,
 * only to venue contracts RAVN routes through, RAVN's fee at most 1% and only to RAVN's own wallet.
 * RavnClient.execute runs it on every answer; call it yourself only for an execution you got
 * another way.
 *
 * What it can't see: whether the swap pays out at a fair price or to the right place, once funds are
 * inside a venue's contract (RAVN's server checks that against each venue); an allowance the user
 * already gave one of those contracts elsewhere (0x's AllowanceHolder and Route's amounts are read; others aren't);
 * and on Solana, what a venue's own program instruction moves: the user signs for every token account
 * they own, and only simulating the transaction shows what it moves (verifyExecution does, given your
 * RPC). Your user's wallet preview is still the last word.
 */
export function checkExecution(execution: ExecutionDTO | AuthorizeDTO, intent: SwapIntent, options: GuardOptions = {}): void {
  // As unknown: narrowing to a Record would drop the AuthorizeDTO interface from the type.
  if (!isRecord(execution as unknown)) fail("RAVN's answer isn't an execution");
  // Signed whatever its quote, so checked whatever it says of itself.
  if (execution.executionType === "AUTHORIZE") return checkAuthorize(context(intent, options), execution, intent);
  // A sandbox execution is never sent, so it's left unchecked: but only when the quote asked for one.
  // RAVN's own flag can't switch the check off.
  if (execution.sandbox) {
    if (intent.sandbox) return;
    fail("RAVN marked this execution as a sandbox one, but its quote wasn't asked for as one");
  }
  const ctx = context(intent, options);

  if (ctx.chainId === BITCOIN_CHAIN_ID || ctx.chainId === SOLANA_CHAIN_ID) {
    return checkNonEvm(ctx, execution, intent);
  }
  if (!KNOWN_CONTRACTS[ctx.chainId]) fail(`This SDK version doesn't know chain ${ctx.chainId}: update @ravnexchange/sdk`);

  const type = (execution as { executionType: string }).executionType;
  if (type === "TRANSACTION" && execution.executionType === "TRANSACTION") {
    if (execution.transaction.serialized) fail("A Solana transaction was returned for an EVM swap");
    if (execution.submit) fail("A submit-through-RAVN transaction was returned for an EVM swap");
    // Hinkal's deposit: its contract is known to this transaction alone (see HINKAL).
    if (HINKAL_CHAINS.includes(ctx.chainId) && lower(execution.transaction.to) === lower(HINKAL)) ctx.known.add(lower(HINKAL));
    // The input token the swap may take (approved, or pulled by 0x or Route: the same funds) plus RAVN's fee
    // transferred beside it, and the coin sent, each within the input amount.
    const approved = execution.approval ? checkApproval(ctx, execution.approval) : 0n;
    const swap = classifyEvmCall(ctx, execution.transaction, "swap");
    // The approval goes to the contract the swap calls (OKX's own approval contract beside its
    // router excepted): an allowance to another one would outlive this swap.
    if (execution.approval) {
      const spender = wordAddress(lower(execution.approval.data), 0);
      const target = lower(execution.transaction.to);
      if (spender !== target && separateSpender(ctx.chainId, target) !== spender) {
        fail("The approval is for a contract the swap doesn't call", { spender, to: target });
      }
    }
    let value = swap.value;
    let tokens = approved > swap.tokens ? approved : swap.tokens;
    if (execution.fee) {
      const feeAmount = checkFeeTerms(ctx, execution.fee, RAVN_FEE_WALLETS.evm);
      if (execution.fee.transaction) {
        const fee = classifyEvmCall(ctx, execution.fee.transaction, "fee", feeAmount);
        value += fee.value;
        tokens += fee.tokens;
      }
    }
    if (value > ctx.amount) fail("The swap sends more of the native coin than the swap's amount", { value: value.toString() });
    if (tokens > ctx.amount) fail("The swap and RAVN's fee take more of the token than the swap's amount", { amount: tokens.toString() });
    if (execution.calls) checkCalls(ctx, execution.calls, [...approvalCalls(execution.approval), execution.transaction, ...(execution.fee?.transaction ? [execution.fee.transaction] : [])]);
    return;
  }

  if (type === "SIGNATURE" && execution.executionType === "SIGNATURE") {
    if (execution.approval) checkApproval(ctx, execution.approval);
    if (execution.approvalData) checkTypedData(ctx, execution.approvalData);
    if (!execution.typedData) fail("The signature request is empty");
    checkTypedData(ctx, execution.typedData);
    return;
  }

  if (type === "DEPOSIT" && execution.executionType === "DEPOSIT") {
    const { deposit, fee } = execution;
    sameChain(ctx, deposit.chainId, "The deposit");
    if (deposit.psbt || deposit.transaction) fail("A Bitcoin or Solana deposit was returned for an EVM swap");
    const depositTo = lower(deposit.address);
    if (!/^0x[0-9a-f]{40}$/.test(depositTo)) fail("The deposit address isn't an EVM address", { address: deposit.address });
    if (depositTo === ctx.token || ctx.known.has(depositTo) || depositTo === lower(RAVN_FEE_WALLETS.evm)) {
      fail("The deposit address is a token, venue contract or RAVN's own wallet", { address: deposit.address });
    }
    let total = big(deposit.amount, "The deposit amount");
    if (fee) {
      const feeAmount = checkFeeTerms(ctx, fee, RAVN_FEE_WALLETS.evm);
      total += feeAmount;
      if (fee.transaction) classifyEvmCall(ctx, fee.transaction, "fee", feeAmount);
    }
    if (total > ctx.amount) fail("The deposit and fee come to more than the swap's amount", { total: total.toString() });
    if (execution.calls?.length) {
      const [first, ...rest] = execution.calls;
      classifyEvmCall(ctx, first, "deposit", big(deposit.amount, "The deposit amount"), depositTo);
      checkCalls(ctx, rest, fee?.transaction ? [fee.transaction] : []);
    }
    return;
  }

  fail(`This SDK version can't check an execution of type ${type}: update @ravnexchange/sdk`);
}

/**
 * checkExecution, then, for a Solana swap with `options.solanaRpcUrl`, a simulation of its transaction
 * on that RPC (see GuardOptions.solanaRpcUrl). RavnClient.execute runs this; call it yourself only for
 * an execution you got another way.
 */
export async function verifyExecution(execution: ExecutionDTO | AuthorizeDTO, intent: SwapIntent, options: GuardOptions = {}, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
  checkExecution(execution, intent, options);
  if (!options.solanaRpcUrl || intent.inputChainId !== SOLANA_CHAIN_ID || execution.executionType === "AUTHORIZE" || execution.sandbox) return;
  const serialized = execution.executionType === "TRANSACTION" ? execution.transaction.serialized : execution.executionType === "DEPOSIT" ? execution.deposit.transaction : undefined;
  if (serialized) await checkSolanaSimulation(serialized, intent, { url: options.solanaRpcUrl, fetch: fetchImpl });
}

const approvalCalls = (a?: ApprovalDTO): Call[] => (a ? [...(a.reset ? [{ ...a.reset, chainId: a.chainId }] : []), a] : []);

// `calls` must be exactly the fields already checked, in order: nothing extra rides along.
function checkCalls(ctx: Ctx, calls: Call[], expected: Call[]) {
  const same = (a: Call, b: Call) =>
    lower(a.to) === lower(b.to) && lower(a.data ?? "0x") === lower(b.data ?? "0x") && big(a.value ?? "0", "A call's value") === big(b.value ?? "0", "A call's value") &&
    a.gasLimit === b.gasLimit;
  if (calls.length !== expected.length || calls.some((c, i) => !same(c, expected[i]))) {
    fail("The execution's calls aren't the transactions it describes");
  }
  for (const c of calls) sameChain(ctx, c.chainId, "A call", true);
}

function checkNonEvm(ctx: Ctx, execution: ExecutionDTO, intent: SwapIntent) {
  const solana = ctx.chainId === SOLANA_CHAIN_ID;
  if (execution.executionType === "TRANSACTION") {
    if (!solana || !execution.transaction.serialized) fail("Only a Solana transaction can come back for this chain");
    if (execution.approval || execution.fee?.transaction || execution.calls?.length) fail("EVM transactions came back for a Solana swap");
    const feeAmount = execution.fee ? checkFeeTerms(ctx, execution.fee, RAVN_FEE_WALLETS.solana) : ctx.feeCap;
    checkSolanaTransaction(execution.transaction.serialized, { ...intent, feeCap: feeAmount });
    return;
  }
  if (execution.executionType === "DEPOSIT") {
    const { deposit, fee } = execution;
    sameChain(ctx, deposit.chainId, "The deposit");
    if (execution.calls?.length) fail("EVM transactions came back for a Bitcoin or Solana deposit");
    let total = big(deposit.amount, "The deposit amount");
    let feeAmount = 0n;
    if (fee) {
      feeAmount = checkFeeTerms(ctx, fee, solana ? RAVN_FEE_WALLETS.solana : RAVN_FEE_WALLETS.bitcoin);
      if (fee.transaction) fail("An EVM fee transaction came back for a Bitcoin or Solana deposit");
      total += feeAmount;
    }
    if (total > ctx.amount) fail("The deposit and fee come to more than the swap's amount", { total: total.toString() });
    if (deposit.psbt) {
      if (solana) fail("A Bitcoin PSBT came back for a Solana deposit");
      checkBitcoinPsbt(deposit.psbt, { deposit, feeAmount, userAddress: intent.userAddress, feeWallet: RAVN_FEE_WALLETS.bitcoin });
    }
    if (deposit.transaction) {
      if (!solana) fail("A Solana transaction came back for a Bitcoin deposit");
      checkSolanaTransaction(deposit.transaction, { ...intent, feeCap: feeAmount, deposit });
    }
    return;
  }
  fail("Only a deposit or a Solana transaction can come back for this chain");
}
