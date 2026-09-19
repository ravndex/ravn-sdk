// isPollingTerminal lives in @ravnexchange/sdk (core) — executeAndTrack needs it too and core
// can't depend on this React package. Re-exported here so existing @ravnexchange/react imports
// don't break.
export { isPollingTerminal } from "@ravnexchange/sdk";

/** Milliseconds until a quote's expiresAt, clamped to 0 (never negative). */
export function msUntilExpiry(expiresAt: number, now: number = Date.now()): number {
  return Math.max(0, expiresAt - now);
}
