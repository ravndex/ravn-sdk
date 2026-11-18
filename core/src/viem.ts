/**
 * @ravnexchange/sdk/viem: ready-made executeAndTrack handlers for a viem wallet client (wagmi's
 * getWalletClient too), with the checks RAVN's own app makes before anything reaches the wallet.
 * No viem import: it reads the clients you pass by shape (checked against viem 2.54's own types).
 * Plain Node ESM (no bundler) imports "@ravnexchange/sdk/dist/viem.js".
 */
import { SentUnclearError } from "./execute-and-track";
import type { ExecuteAndTrackHandlers } from "./execute-and-track";
import type { ApprovalDTO } from "./types";

type Hex = `0x${string}`;
type TxLike = Parameters<ExecuteAndTrackHandlers["sendTransaction"]>[0];
type Account = { address: Hex };
/** What viem needs as `chain` on a send: it checks the wallet is on it and names it in the request. */
type ChainLike = { id: number; name: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: { default: { http: readonly string[] } } };

/** The parts of a viem wallet client (createWalletClient, or wagmi's getWalletClient) these handlers use. */
export interface ViemWalletClient {
  account?: Account;
  getChainId(): Promise<number>;
  switchChain(args: { id: number }): Promise<void>;
  sendTransaction(args: {
    chain: ChainLike;
    to: Hex;
    data: Hex;
    value: bigint;
    gas: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }): Promise<Hex>;
  signTypedData(args: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<Hex>;
  signMessage(args: { message: string }): Promise<Hex>;
  /** EIP-5792: without these three, nothing is batched. */
  getCapabilities?(args: { chainId: number }): Promise<{ atomic?: { status?: string } }>;
  sendCalls?(args: { chain: ChainLike; calls: { to: Hex; data: Hex; value: bigint }[]; forceAtomic: boolean }): Promise<{ id: string }>;
  waitForCallsStatus?(args: { id: string; timeout: number }): Promise<{ status?: string; statusCode: number; receipts?: { transactionHash: Hex }[] }>;
}

/** The parts of a viem public client (createPublicClient, or wagmi's getPublicClient) these handlers use. */
export interface ViemPublicClient {
  chain?: { id: number; name: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: { default: { http: readonly string[] } } };
  estimateGas(args: { account: Hex; to: Hex; data: Hex; value: bigint }): Promise<bigint>;
  call(args: { to: Hex; data: Hex }): Promise<{ data?: Hex }>;
  waitForTransactionReceipt(args: { hash: Hex; onReplaced?: (replacement: { reason: string }) => void }): Promise<{ status: string; transactionHash: Hex }>;
  getBlock(): Promise<{ timestamp: bigint; number: bigint | null; baseFeePerGas: bigint | null }>;
  getBalance(args: { address: Hex }): Promise<bigint>;
  getCode(args: { address: Hex }): Promise<Hex | undefined>;
  estimateMaxPriorityFeePerGas(): Promise<bigint>;
  /** eth_simulateV1: without it, the gas check and batching are skipped. */
  simulateBlocks?(args: {
    blockNumber?: bigint;
    blocks: { blockOverrides: { time: bigint }; calls: { account: Hex; to: Hex; data: Hex; value: bigint; gas?: bigint }[] }[];
  }): Promise<readonly { calls: readonly { status: string; gasUsed: bigint }[] }[]>;
}

export interface ViemHandlersOptions {
  /** The paying wallet: a wallet client with its account (which signs and sends everything), or a function returning the current one
   * (wagmi: `() => getWalletClient(config)`). It must be on the swap's chain or able to switch. */
  walletClient: ViemWalletClient | (() => ViemWalletClient | Promise<ViemWalletClient>);
  /** A public client for a chain id (wagmi: `(chainId) => getPublicClient(config, { chainId })`), or
   * one client, used only for its own chain. Nothing is sent on a chain without one. */
  publicClient: ViemPublicClient | ((chainId: number) => ViemPublicClient | undefined);
}

const ETHEREUM = 1;
const MONAD = 143;
const HYPEREVM = 999;
// HyperEVM's 1-second blocks hold 3M gas: a higher limit waits for a block it never gets. Its sends
// carry 10% over the estimate, not 50%: every unneeded unit of limit delays it there.
const HYPEREVM_BLOCK_GAS = 3_000_000n;
// Arbitrum Nitro chains whose base fee rises in most blocks: a wallet capping the fee at today's base
// fee has about half its sends refused. Sent with twice the base fee as the cap, no tip.
const FEE_HEADROOM_CHAINS = new Set([4663, 99901]); // Robinhood Chain, Elysium
// A batch carries no gas limit (EIP-5792) and wallets leave little headroom: a call simulated above
// this goes one by one, with the 1.5× limit.
const BATCH_MAX_GAS = 400_000n;
// EIP-5792 / EIP-1193 codes a wallet returns before showing anything: method, capability, chain,
// bundle size or atomicity unsupported.
const BATCH_REFUSED_BEFORE_PROMPT = new Set([-32601, 4200, 5700, 5710, 5740, 5760]);

// Per wallet + chain, for this page's life: its atomic-batch status, asked once (undefined = no answer
// in 3 s), and the pairs that go one by one from now on (declined the account upgrade, or a batch
// that ended unclearly or was refused).
const batchSupport = new Map<string, string | undefined>();
const noBatch = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `promise`, or null after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(timer));
}

/** The numeric JSON-RPC / EIP-1193 code anywhere in an error's cause chain. */
function rpcErrorCode(e: unknown): number | undefined {
  for (let c: unknown = e, depth = 0; c && depth < 8; c = (c as { cause?: unknown }).cause, depth++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

/** `wei` in whole coins, two significant digits, rounded up. */
function coins(wei: bigint, decimals: number): string {
  const unit = 10n ** BigInt(Math.max(wei.toString().length - 2, 0));
  const s = (((wei + unit - 1n) / unit) * unit).toString().padStart(decimals + 1, "0");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${s.slice(0, s.length - decimals)}${frac ? `.${frac}` : ""}`;
}

function gasMoneyError(client: ViemPublicClient | undefined, short: bigint): Error {
  const coin = client?.chain?.nativeCurrency;
  const symbol = coin?.symbol ?? "of the chain's gas coin";
  const about = short > 0n ? ` about ${coins(short, coin?.decimals ?? 18)}` : "";
  return new Error(`This wallet needs${about} more ${symbol} to pay the network fee, so it wasn't sent. Add a little, then try again.`);
}

/** A wallet's refusal for gas money (viem's InsufficientFundsError) as the gas-money error, else null. */
function gasMoneyRefusal(e: unknown, client: ViemPublicClient | undefined): Error | null {
  for (let c: unknown = e, depth = 0; c && depth < 8; c = (c as { cause?: unknown }).cause, depth++) {
    if ((c as { name?: unknown }).name !== "InsufficientFundsError") continue;
    const haveWant = /have (\d+) want (\d+)/.exec(String((e as { details?: unknown }).details ?? (e as { message?: unknown }).message));
    return gasMoneyError(client, haveWant ? BigInt(haveWant[2]) - BigInt(haveWant[1]) : 0n);
  }
  return null;
}

const callsOf = (txs: TxLike[]) => txs.map((t) => ({ to: t.to as Hex, data: (t.data ?? "0x") as Hex, value: BigInt(t.value ?? "0") }));

/**
 * eth_simulateV1 of `txs` in one block stamped `time` (default about now). Left alone a node stamps it
 * 12 s after its latest block, where a short-dated quote reverts though it fills on-chain; a node that
 * refuses a stamp not after its latest block (-38021) gets one a second after it.
 */
async function simulateNow(client: ViemPublicClient, account: Hex, txs: TxLike[], time = BigInt(Math.ceil(Date.now() / 1000) + 2), gas?: bigint) {
  const calls = callsOf(txs).map((c) => ({ ...c, account, ...(gas ? { gas } : {}) }));
  const run = (stamp: bigint, blockNumber?: bigint) =>
    client.simulateBlocks!({ ...(blockNumber == null ? {} : { blockNumber }), blocks: [{ blockOverrides: { time: stamp }, calls }] });
  try {
    return (await run(time))[0].calls;
  } catch (e) {
    if (rpcErrorCode(e) !== -38021) throw e;
    const latest = await client.getBlock();
    return (await run(latest.timestamp + 1n, latest.number ?? undefined))[0].calls;
  }
}

/** The limit RAVN's app sends with: 1.5× the estimate (HyperEVM 1.1×). */
const limitFor = (chainId: number, estimated: bigint) => (estimated * (chainId === HYPEREVM ? 110n : 150n)) / 100n;

/**
 * executeAndTrack handlers for a viem wallet client, with RAVN's app's protections: the wallet is on
 * the swap's chain before anything is signed or sent (switched, then read back); every transaction
 * goes with a gas limit (RAVN's, else 1.5× an estimate retried 3 times, and refused with nothing sent
 * if it never estimates); an approval goes only when the allowance isn't there yet, and only if the
 * wallet can also pay the swap's gas; an approval and the swap go in one confirmation (EIP-5792) where
 * the wallet and RAVN allow it and the batch simulates cleanly, else one by one.
 */
export function viemHandlers(options: ViemHandlersOptions): ExecuteAndTrackHandlers {
  const wallet = async () => (typeof options.walletClient === "function" ? await options.walletClient() : options.walletClient);
  const publicFor = (chainId: number | undefined): ViemPublicClient | undefined => {
    if (chainId === undefined) return undefined;
    const client = typeof options.publicClient === "function" ? options.publicClient(chainId) : options.publicClient;
    return client && (client.chain === undefined || client.chain.id === chainId) ? client : undefined;
  };
  const chainFor = (chainId: number, client: ViemPublicClient): ChainLike =>
    client.chain ?? { id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };
  const accountOf = (w: ViemWalletClient): Account => {
    if (!w.account) throw new Error("The wallet client has no account, so nothing more was signed or sent");
    return w.account;
  };

  // Switched, then read back: a dismissed switch prompt can resolve without moving the wallet.
  const onChain = async (chainId: number | undefined): Promise<ViemWalletClient> => {
    if (!chainId) throw new Error("This transaction names no chain, so it wasn't sent");
    const w = await wallet();
    if ((await w.getChainId()) === chainId) return w;
    await w.switchChain({ id: chainId });
    const moved = await wallet();
    const active = await moved.getChainId();
    if (active !== chainId) throw new Error(`The wallet is on chain ${active}, not ${chainId}, so nothing more was signed or sent. Switch networks and try again.`);
    return moved;
  };

  const handlers: ExecuteAndTrackHandlers = {
    batchApprovals: true,

    async sendTransaction(tx) {
      if (tx.serialized || !tx.to) throw new Error("This is a Solana transaction: add the Solana add-on's handlers. It wasn't sent.");
      const w = await onChain(tx.chainId);
      const chainId = tx.chainId!;
      const client = publicFor(chainId);
      if (!client) throw new Error(`No public client for chain ${chainId}, so this transaction wasn't sent`);
      const account = accountOf(w);
      const [call] = callsOf([tx]);
      // RAVN's limit (its own run, plus half), except on HyperEVM, where 50% over delays the send.
      let gas = tx.gasLimit && chainId !== HYPEREVM ? BigInt(tx.gasLimit) : undefined;
      // Three tries: a node a block behind a just-mined approval sees no allowance and reverts.
      for (let attempt = 0; gas === undefined && attempt < 3; attempt++) {
        if (attempt) await sleep(400);
        gas = await client.estimateGas({ account: account.address, ...call }).then((g) => limitFor(chainId, g), () => undefined);
      }
      if (gas === undefined) throw new Error("Couldn't confirm this transaction will succeed, so it wasn't sent. Refresh the quote and try again.");
      if (chainId === HYPEREVM && gas > HYPEREVM_BLOCK_GAS) {
        throw new Error("This transaction is too heavy for HyperEVM's blocks right now, so it wasn't sent. Try a smaller amount, or refresh the quote for another route.");
      }
      let fees = {};
      if (FEE_HEADROOM_CHAINS.has(chainId)) {
        const base = (await within(client.getBlock(), 2_000).catch(() => null))?.baseFeePerGas;
        if (base) fees = { maxFeePerGas: base * 2n, maxPriorityFeePerGas: 0n };
      }
      try {
        return await w.sendTransaction({ chain: chainFor(chainId, client), ...call, gas, ...fees });
      } catch (e) {
        throw gasMoneyRefusal(e, client) ?? e;
      }
    },

    async waitForReceipt(hash, chainId) {
      const client = publicFor(chainId ?? (await (await wallet()).getChainId()));
      if (!client) throw new Error(`No public client for chain ${chainId}, so this transaction's receipt can't be read`);
      // Cancelled or replaced by another transaction (not just repriced): this one never ran.
      let replaced = false;
      const receipt = await client.waitForTransactionReceipt({ hash: hash as Hex, onReplaced: (r) => void (replaced ||= r.reason !== "repriced") });
      return replaced ? { status: "reverted", transactionHash: hash } : receipt;
    },

    async hasAllowance(approval: ApprovalDTO) {
      const client = publicFor(approval.chainId);
      const owner = (await wallet()).account?.address;
      if (!client || !owner || !approval.spender) return false;
      const pad = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      try {
        const { data } = await client.call({ to: approval.to as Hex, data: `0xdd62ed3e${pad(owner)}${pad(approval.spender)}` });
        return !!data && data.length >= 66 && BigInt(data.slice(0, 66)) >= BigInt(approval.amount);
      } catch {
        return false; // unreadable: the approval goes, as without this
      }
    },

    // Before approvals one by one: they mine and spend gas before the wallet sees the swap, so a wallet
    // that can't also pay for the swap is left with gas spent and an approval open. Approvals and the
    // swap simulated together; their gas at twice the base fee plus the tip, and the swap's value,
    // against the balance. Skipped when anything can't be read, for a contract account (an owner or
    // paymaster may pay; a 7702-delegated EOA pays its own and is checked), and on Monad, whose
    // simulation reports the gas given as used.
    async preflight(txs) {
      if (txs.length < 2) return;
      const swap = txs[txs.length - 1];
      const chainId = swap.chainId;
      const client = publicFor(chainId);
      const account = (await wallet()).account?.address;
      if (!chainId || chainId === MONAD || !client?.simulateBlocks || !account || txs.some((t) => !t.to)) return;
      let short: bigint;
      try {
        const [results, balance, block, tip, code] = await Promise.all([
          simulateNow(client, account, txs),
          client.getBalance({ address: account }),
          client.getBlock(),
          client.estimateMaxPriorityFeePerGas(),
          client.getCode({ address: account }),
        ]);
        if (code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100")) return;
        if (block.baseFeePerGas == null || results.length !== txs.length || results.some((r) => r.status !== "success")) return;
        const used = results[results.length - 1].gasUsed;
        const swapGas = swap.gasLimit && chainId !== HYPEREVM ? BigInt(swap.gasLimit) : limitFor(chainId, used);
        const gas = results.slice(0, -1).reduce((sum, r) => sum + r.gasUsed, swapGas);
        const value = txs.reduce((sum, t) => sum + BigInt(t.value ?? "0"), 0n);
        short = gas * (block.baseFeePerGas * 2n + tip) + value - balance;
      } catch {
        return;
      }
      if (short > 0n) throw gasMoneyError(client, short);
    },

    // One confirmation (EIP-5792, atomic), or null for one by one: the wallet can't batch on this
    // chain, the batch doesn't simulate cleanly at the next block, a call is too heavy for a batch's
    // thin gas margin, or the wallet refused it before showing anything.
    async sendCalls(txs) {
      const chainId = txs[0]?.chainId;
      if (!chainId || txs.some((t) => t.chainId !== chainId || !t.to || t.serialized)) return null;
      const w = await onChain(chainId);
      const client = publicFor(chainId);
      if (!client?.simulateBlocks || !w.getCapabilities || !w.sendCalls || !w.waitForCallsStatus) return null;
      const account = accountOf(w);
      const key = `${account.address}:${chainId}`.toLowerCase();
      let atomic: string | undefined;
      try {
        if (!batchSupport.has(key)) {
          // Over WalletConnect the question is a round trip to a phone that may never answer.
          const caps = await within(w.getCapabilities({ chainId }), 3_000).catch(() => null);
          batchSupport.set(key, caps?.atomic?.status);
        }
        atomic = batchSupport.get(key);
        if ((atomic !== "supported" && atomic !== "ready") || noBatch.has(key)) return null;
        const { timestamp } = await client.getBlock();
        // The chain's next block, by its own clock (the device's can be minutes off).
        const next = timestamp + (chainId === ETHEREUM ? 12n : 2n);
        const results = await simulateNow(client, account.address, txs, next, chainId === MONAD ? BATCH_MAX_GAS : undefined);
        if (results.length !== txs.length || results.some((r) => r.status !== "success" || !(r.gasUsed <= BATCH_MAX_GAS))) return null;
      } catch {
        return null;
      }

      // From the prompt on, anything may have reached the chain: no failure falls back to one by one.
      const unclear = (id?: string) =>
        new SentUnclearError(`The wallet didn't confirm how this swap ended, so it may still go through. Check its activity before trying again${id ? ` (batch ${id})` : ""}.`);
      let id: string;
      try {
        ({ id } = await w.sendCalls({ chain: chainFor(chainId, client), calls: callsOf(txs), forceAtomic: true }));
      } catch (e) {
        const code = rpcErrorCode(e);
        if (code === 4001) {
          // A cancel. On "ready" the same prompt offered the account upgrade: not again this session.
          if (atomic === "ready") noBatch.add(key);
          throw e;
        }
        // The user declined only the upgrade, or the wallet refused before any prompt.
        if (code === 5750) noBatch.add(key);
        if (code === 5750 || (code !== undefined && BATCH_REFUSED_BEFORE_PROMPT.has(code))) return null;
        const gasShort = gasMoneyRefusal(e, client);
        if (gasShort) throw gasShort;
        noBatch.add(key);
        throw unclear();
      }
      const result = await w.waitForCallsStatus({ id, timeout: 10 * 60_000 }).catch(() => null);
      if (!result) throw unclear(id);
      const hashes = (result.receipts ?? []).map((r) => r.transactionHash).filter(Boolean);
      if (result.status === "failure" && result.statusCode === 400 && !hashes.length) {
        // EIP-5792 400: the batch never reached the chain. The next swap goes one by one.
        noBatch.add(key);
        throw new Error("The wallet didn't send the swap, so nothing reached the chain and nothing was spent. Refresh the quote and try again.");
      }
      // Landed, or ran and reverted (RAVN's status then says failed): either way, its hashes.
      if ((result.status === "success" || result.status === "failure") && hashes.length) return hashes;
      throw unclear(id);
    },

    async signTypedData(typedData) {
      // A wallet refuses typed data whose domain names another chain.
      const chainId = Number((typedData.domain as { chainId?: unknown } | undefined)?.chainId);
      const w = Number.isSafeInteger(chainId) && chainId > 0 ? await onChain(chainId) : await wallet();
      const { EIP712Domain: _, ...types } = typedData.types as Record<string, unknown>;
      accountOf(w);
      return w.signTypedData({
        domain: typedData.domain as Record<string, unknown>,
        types,
        primaryType: typedData.primaryType as string,
        message: typedData.message as Record<string, unknown>,
      });
    },

    async signMessage(message) {
      const w = await wallet();
      accountOf(w);
      return w.signMessage({ message });
    },

    async switchChain(chainId) {
      await onChain(chainId);
    },
  };
  return handlers;
}
