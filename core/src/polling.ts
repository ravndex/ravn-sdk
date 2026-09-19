import type { SettlementStatus } from "./types";

/**
 * Whether a status is done changing. "unknown" counts as terminal even though it isn't a real
 * outcome: it means the venue has no live tracker (see StatusDTO.tracking), so it will never
 * change and polling forever would just spin. Only "pending"/"processing" keep polling.
 */
export function isPollingTerminal(status: SettlementStatus): boolean {
  return status !== "pending" && status !== "processing";
}
