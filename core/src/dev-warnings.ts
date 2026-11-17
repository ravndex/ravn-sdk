import type { AuthorizeDTO, ExecutionDTO, StatusDTO } from "./types";

/**
 * Console warnings while a partner builds, for what RAVN's server can't see from its side: RAVN's
 * fee not sent beside a swap, and a swap built but never tracked. Off when process.env.NODE_ENV is
 * "production" or "test" (RavnClientConfig.devWarnings). Kept per client here rather than on
 * RavnClient, so none of it is public API, and a client from another copy of this package is just
 * never warned on. Every hook is safe: a warning never throws into a swap.
 */

/** How long a swap may go untracked, or a fee's hash unreported after the swap succeeded, before a warning. */
export const TRACK_WITHIN_MS = 10 * 60_000;
/** What each client remembers, per kind: a dev warning, never a memory leak. */
const MAX_WATCHED = 1_000;
const PREFIX = "[@ravnexchange/sdk]";
const OFF = "(new RavnClient({ devWarnings: false }) turns these warnings off)";

// Read as written, inside try: a bundler replaces `process.env.NODE_ENV` in the text, and where
// nothing defines `process` (a browser without a bundler) it throws, which reads as development.
// "test": jest and vitest set it, and a suite may fail on any console.warn.
declare const process: { env: { NODE_ENV?: string } };
const quietEnv = (): boolean => {
  try {
    const env = process.env.NODE_ENV;
    return env === "production" || env === "test";
  } catch {
    return false;
  }
};

type Timer = ReturnType<typeof setTimeout>;
interface Watch {
  /** Swaps already warned about their fee: one fee warning per swap. */
  warned: Set<string>;
  /** Built, not yet tracked: quoteToken → its warning's timer. */
  untracked: Map<string, Timer>;
  /** Built with RAVN's fee as a transaction of its own, never yet polled with a hash: its timer once it succeeded. */
  feeBeside: Map<string, Timer | undefined>;
}
const watches = new WeakMap<object, Watch>();
/** "Never tracked" is said once per process: the first says it all, and a server making a client per request isn't flooded. */
let untrackedSaid = false;
/** For this package's tests: "never tracked" may be said again. */
export const resetUntrackedWarning = (): void => {
  untrackedSaid = false;
};

// A hook that fails (an odd answer, a console.warn that throws) is skipped, never thrown.
const safe =
  <A extends unknown[]>(fn: (...args: A) => void) =>
  (...args: A): void => {
    try {
      fn(...args);
    } catch {
      // A development warning, never the swap.
    }
  };
const say = (message: string) => console.warn(`${PREFIX} ${message} ${OFF}`);
// Never what keeps a process alive (a script, a server shutting down): Node's and Bun's timers, and Deno's ids.
const later = (fn: () => void): Timer => {
  const timer = setTimeout(safe(fn), TRACK_WITHIN_MS);
  (timer as { unref?: () => void }).unref?.();
  (globalThis as { Deno?: { unrefTimer?: (id: unknown) => void } }).Deno?.unrefTimer?.(timer);
  return timer;
};
const cap = <K>(kept: Set<K> | Map<K, unknown>, drop?: (key: K) => void) => {
  while (kept.size > MAX_WATCHED) {
    const oldest = kept.keys().next().value as K;
    drop?.(oldest);
    kept.delete(oldest);
  }
};
const forgetFee = (w: Watch, quoteToken: string) => {
  clearTimeout(w.feeBeside.get(quoteToken));
  w.feeBeside.delete(quoteToken);
};
const warnFee = (w: Watch, quoteToken: string, message: string) => {
  forgetFee(w, quoteToken);
  if (w.warned.has(quoteToken)) return;
  w.warned.add(quoteToken);
  cap(w.warned);
  say(message);
};

export const startDevWarnings = safe((client: object, on: boolean | undefined) => {
  if (on ?? !quietEnv()) watches.set(client, { warned: new Set(), untracked: new Map(), feeBeside: new Map() });
});

/** execute() answered with a swap to send: warn if nothing tracks it within TRACK_WITHIN_MS. */
export const noteBuilt = safe((client: object, execution: ExecutionDTO | AuthorizeDTO) => {
  const w = watches.get(client);
  if (!w || execution.executionType === "AUTHORIZE") return;
  const { quoteToken } = execution;
  if ("fee" in execution && execution.fee?.transaction && !execution.sandbox && !w.feeBeside.has(quoteToken)) {
    w.feeBeside.set(quoteToken, undefined);
    cap(w.feeBeside, (k) => clearTimeout(w.feeBeside.get(k)));
  }
  clearTimeout(w.untracked.get(quoteToken));
  w.untracked.delete(quoteToken);
  if (untrackedSaid || w.untracked.size >= MAX_WATCHED) return;
  w.untracked.set(
    quoteToken,
    later(() => {
      w.untracked.delete(quoteToken);
      if (untrackedSaid) return;
      untrackedSaid = true;
      say(
        `execute() built a swap ${TRACK_WITHIN_MS / 60_000} minutes ago and nothing has tracked it since (no getStatus, submitSignature or submitTransaction for its quoteToken). RAVN books a swap, and the fee your share is paid from, on its status polls: once the swap is sent, poll getStatus(execution.quoteToken, ref) until a final status, as executeAndTrack does. Ignore this if you track swaps on your server or with another client, or your user never sent it.`
      );
    })
  );
});

/** A status poll or a submit for this swap: it's tracked. A `txHash` on a poll is how a fee beside it is proven. */
export const noteTracked = safe((client: object, quoteToken: string, txHash?: string) => {
  const w = watches.get(client);
  if (!w) return;
  clearTimeout(w.untracked.get(quoteToken));
  w.untracked.delete(quoteToken);
  if (txHash) forgetFee(w, quoteToken);
});

/**
 * A status answer. A swap with RAVN's fee beside it that succeeded, polled without a hash so far:
 * RAVN keeps it open for a poll that brings the fee's hash, so the warning waits TRACK_WITHIN_MS for one.
 */
export const noteStatus = safe((client: object, quoteToken: string, status: StatusDTO) => {
  const w = watches.get(client);
  if (!w || status.status !== "success" || !w.feeBeside.has(quoteToken) || w.feeBeside.get(quoteToken) !== undefined) return;
  w.feeBeside.set(
    quoteToken,
    later(() =>
      warnFee(
        w,
        quoteToken,
        `A swap whose RAVN fee is a transaction of its own (execution.fee.transaction) succeeded ${TRACK_WITHIN_MS / 60_000} minutes ago, and no getStatus call for it has passed a txHash. If that fee transaction wasn't sent, no fee is owed to you on this swap. Send fee.transaction once the swap confirms, and pass its hash as txHash on the polls after it, as executeAndTrack does.`
      )
    )
  );
});

/** executeAndTrack's: RAVN's fee beside a swap wasn't sent, or can't be proven (its `feeError`), said now, not only in the result. */
export const warnFeeNotSent = safe((client: object, execution: ExecutionDTO | undefined, feeError: unknown) => {
  const w = watches.get(client);
  if (!w || feeError === undefined || !execution || execution.sandbox) return;
  const why = feeError instanceof Error ? feeError.message : String(feeError);
  warnFee(
    w,
    execution.quoteToken,
    `RAVN's fee on this swap wasn't sent, or can't be proven: ${why}. If the swap went through, no fee is owed to you on it. executeAndTrack returns this as feeError: check it after every swap.`
  );
});
