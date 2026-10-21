import type { RavnClient } from "./client";
import type { ExecuteAndTrackHandlers } from "./execute-and-track";
import type { RecoverDTO } from "./types";

export type RecoverHandlers = Required<Pick<ExecuteAndTrackHandlers, "signMessage" | "signTypedData">> & Pick<ExecuteAndTrackHandlers, "switchChain">;

type Recovered = Extract<RecoverDTO, { status: "done" }>["recovered"];

// RAVN offers a swap's recoveries on its source chain, one per stuck token: a handful at most.
const MAX_RECOVERIES = 8;

/**
 * Gets back everything a failed Hinkal swap left at Hinkal, which it never refunds on its own:
 * starts the recovery for the swap's `statusRef`, has the wallet that paid for it sign the read-only
 * session, then each recovery (after switchChain to its chain, when given), and looks again after
 * each until nothing is left. `userAddress` is that wallet, from your own wallet connection, never
 * from a RAVN answer: every answer is checked to send funds back to it alone before the wallet sees
 * it (RavnClient.recover, unless its guard is off). One session per run, and up to 8 recoveries,
 * all on one chain, each kind and token once: offered one again (just recovered, or not yet read as
 * gone), it stops there. Resolves to what was sent back, before Hinkal's recovery fee: empty when
 * nothing was stuck. A failed payout's refund shows a few minutes after the failure, so an empty
 * answer soon after it is worth trying again later. Errors come as they are; what was sent back
 * before one stays in the wallet, and nothing signed can move funds anywhere else.
 */
export async function recoverStuckFunds(
  client: RavnClient,
  { statusRef, userAddress }: { statusRef: string; userAddress: string },
  handlers: RecoverHandlers
): Promise<{ recovered: Recovered }> {
  const recovered: Recovered = [];
  const signed = new Set<string>();
  let chain: number | undefined;
  let recoveries = 0;
  const ask = (more: { authorization?: string; signature?: `0x${string}` } = {}) => client.recover({ statusRef, ...more }, { userAddress });
  let answer = await ask();
  // "done" answers a recovery's signature only: anything else asking to look again is refused.
  let afterRecovery = false;
  for (;;) {
    if (answer.status === "nothing") return { recovered };
    if (answer.status === "done") {
      if (!afterRecovery) throw new Error("recoverStuckFunds: RAVN said done without a recovery being signed");
      recovered.push(...answer.recovered);
      afterRecovery = false;
      answer = await ask({ authorization: answer.authorization });
      continue;
    }
    const { authorization, sign, expiresAt } = answer;
    const live = () => {
      if (!(Date.parse(expiresAt) > Date.now())) throw new Error("recoverStuckFunds: the signature request expired: start the recovery again");
    };
    live();
    let signature: `0x${string}`;
    // Called as methods: a class-instance wallet needs its `this`.
    if (sign.method === "personal_sign") {
      if (signed.has("session")) throw new Error("recoverStuckFunds: RAVN asked to sign the session a second time: nothing more was signed");
      signed.add("session");
      signature = await handlers.signMessage(sign.message);
    } else {
      // checkRecovery held these to a recovery on a chain Hinkal runs on, of one token.
      const { primaryType, domain, message } = sign.typedData as { primaryType: string; domain: { chainId: number }; message: { tokenAddress: unknown } };
      const key = `${primaryType}:${domain.chainId}:${String(message.tokenAddress).toLowerCase()}`;
      if (signed.has(key)) return { recovered };
      if (chain !== undefined && domain.chainId !== chain) {
        throw new Error(`recoverStuckFunds: RAVN asked for a recovery on chain ${domain.chainId} after one on chain ${chain}: a swap's are all on its source chain`);
      }
      if (recoveries === MAX_RECOVERIES) throw new Error(`recoverStuckFunds: RAVN asked for more than ${MAX_RECOVERIES} recoveries: nothing more was signed`);
      recoveries++;
      signed.add(key);
      chain = domain.chainId;
      if (handlers.switchChain) await handlers.switchChain(domain.chainId);
      signature = await handlers.signTypedData(sign.typedData);
    }
    live();
    afterRecovery = sign.method === "eth_signTypedData_v4";
    answer = await ask({ authorization, signature });
  }
}
