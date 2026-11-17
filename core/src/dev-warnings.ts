import type { AuthorizeDTO, ExecutionDTO, StatusDTO } from "./types";

/**
 * Console warnings while a partner builds, for what RAVN's server can't see from its side: RAVN's
 * fee not sent beside a swap, and a swap built but never tracked. On unless process.env.NODE_ENV is
 * "production" (RavnClientConfig.devWarnings). Kept per client here rather than on RavnClient, so
 * none of it is public API, and a client from another copy of this package is just never warned on.
 */

/** A swap execute() built and nothing tracked within this long is warned on. */
export const TRACK_WITHIN_MS = 10 * 60_000;
/** Swaps watched at once per client: a dev warning, never a memory leak. */
const MAX_WATCHED = 1_000;
const PREFIX = "[@ravnexchange/sdk]";
const OFF = "(new RavnClient({ devWarnings: false }) turns these warnings off)";

// Read as written, inside try: a bundler replaces `process.env.NODE_ENV` in the text, and where
// nothing defines `process` (a browser without a bundler) it throws, which reads as development.
declare const process: { env: { NODE_ENV?: string } };
const production = (): boolean => {
  try {
    return process.env.NODE_ENV === "production";
  } catch {
    return false;
  }
};

interface Watch {
  warned: Set<string>;
  /** Built, not yet tracked: quoteToken → its warning's timer. */
  untracked: Map<string, ReturnType<typeof setTimeout>>;
  /** Built with RAVN's fee as a transaction of its own, never yet polled with a txHash. */
  feeBeside: Set<string>;
}
const watches = new WeakMap<object, Watch>();

export function startDevWarnings(client: object, on: boolean | undefined): void {
  if (on ?? !production()) watches.set(client, { warned: new Set(), untracked: new Map(), feeBeside: new Set() });
}

export function warnOnce(client: object, key: string, message: string): void {
  const w = watches.get(client);
  if (!w || w.warned.has(key)) return;
  w.warned.add(key);
  console.warn(`${PREFIX} ${message} ${OFF}`);
}

const add = <T>(set: Set<T>, value: T) => {
  set.delete(value);
  set.add(value);
  if (set.size > MAX_WATCHED) set.delete(set.values().next().value as T);
};

/** execute() answered with a swap to send: warn if nothing tracks it within TRACK_WITHIN_MS. */
export function noteBuilt(client: object, execution: ExecutionDTO | AuthorizeDTO): void {
  const w = watches.get(client);
  if (!w || execution.executionType === "AUTHORIZE") return;
  const { quoteToken } = execution;
  if ("fee" in execution && execution.fee?.transaction && !execution.sandbox) add(w.feeBeside, quoteToken);
  // Once per client: the first says it all, and a server whose swaps are tracked elsewhere isn't flooded.
  if (w.warned.has("untracked")) return;
  clearTimeout(w.untracked.get(quoteToken));
  w.untracked.delete(quoteToken);
  if (w.untracked.size >= MAX_WATCHED) return;
  const timer = setTimeout(() => {
    w.untracked.delete(quoteToken);
    warnOnce(
      client,
      "untracked",
      `execute() built a swap ${TRACK_WITHIN_MS / 60_000} minutes ago and nothing has tracked it since (no getStatus, submitSignature or submitTransaction for its quoteToken). RAVN books a swap, and the fee your share is paid from, on its status polls: once the swap is sent, poll getStatus(execution.quoteToken, ref) until a final status, as executeAndTrack does. Ignore this if you track swaps on your server or with another client, or your user never sent it.`
    );
  }, TRACK_WITHIN_MS);
  // Never what keeps a Node process (a script, a server shutting down) alive.
  (timer as { unref?: () => void }).unref?.();
  w.untracked.set(quoteToken, timer);
}

/** A status poll or a submit for this swap: it's tracked. `txHash` proves a fee beside it. */
export function noteTracked(client: object, quoteToken: string, txHash?: string): void {
  const w = watches.get(client);
  if (!w) return;
  clearTimeout(w.untracked.get(quoteToken));
  w.untracked.delete(quoteToken);
  if (txHash) w.feeBeside.delete(quoteToken);
}

/** A status answer: a swap that succeeded with RAVN's fee beside it, never polled with that fee's hash. */
export function noteStatus(client: object, quoteToken: string, status: StatusDTO): void {
  const w = watches.get(client);
  if (!w || status?.status !== "success" || !w.feeBeside.has(quoteToken)) return;
  w.feeBeside.delete(quoteToken);
  warnOnce(
    client,
    `fee:${quoteToken}`,
    "A swap whose RAVN fee is a transaction of its own (execution.fee.transaction) finished, and no getStatus call for it passed that transaction's hash as txHash. RAVN proves the fee from it, so no fee is owed to you on this swap. Send fee.transaction once the swap confirms, and pass its hash on every getStatus poll after it, as executeAndTrack does."
  );
}

/** executeAndTrack's: RAVN's fee wasn't sent beside a swap (its `feeError`), said now, not only in the result. */
export function warnFeeNotSent(client: object, execution: ExecutionDTO | undefined, feeError: unknown): void {
  if (feeError === undefined || !execution || execution.sandbox) return;
  const why = feeError instanceof Error ? feeError.message : String(feeError);
  warnOnce(
    client,
    `fee:${execution.quoteToken}`,
    `RAVN's fee on this swap wasn't sent: ${why}. The swap still runs, but no fee is owed to you on it. executeAndTrack returns this as feeError: check it after every swap.`
  );
}
