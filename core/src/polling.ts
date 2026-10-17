import type { SettlementStatus } from "./types";

/**
 * Whether a status is done changing. "unknown" counts as terminal even though it isn't a real
 * outcome: it means the venue has no live tracker (see StatusDTO.tracking), so it will never
 * change and polling forever would just spin. "expired" doesn't: the deal lapsed and a refund is
 * due but hasn't landed (Across returns it in a later settlement bundle, hours on), and it turns
 * "refunded" when it does. Poll it on a longer interval. "pending"/"processing"/"expired" keep
 * polling.
 */
export function isPollingTerminal(status: SettlementStatus): boolean {
  return status !== "pending" && status !== "processing" && status !== "expired";
}
