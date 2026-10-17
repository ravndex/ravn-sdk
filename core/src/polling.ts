import type { SettlementStatus } from "./types";

/**
 * Whether a status is done changing: "success", "refunded" and "failed", RAVN's own final states,
 * plus "unknown", which isn't a real outcome but means the venue has no live tracker (see
 * StatusDTO.tracking), so it will never change and polling forever would just spin. Everything
 * else keeps polling: "expired" means the deal lapsed and a refund is due but hasn't landed
 * (Across returns it in a later settlement bundle, hours on; poll it on a longer interval), and
 * "not_found" that the venue has no record of the swap yet (a venue indexing behind the chain).
 */
export function isPollingTerminal(status: SettlementStatus): boolean {
  return status === "success" || status === "refunded" || status === "failed" || status === "unknown";
}
