import type { RavnClient } from "./client";
import type { ExecuteAndTrackHandlers } from "./execute-and-track";
import type { RecoverDTO } from "./types";

export type RecoverHandlers = Required<Pick<ExecuteAndTrackHandlers, "signMessage" | "signTypedData">> & Pick<ExecuteAndTrackHandlers, "switchChain">;

type Recovered = Extract<RecoverDTO, { status: "done" }>["recovered"];

/**
 * Gets back everything a failed Hinkal swap left at Hinkal, which it never refunds on its own:
 * starts the recovery for the swap's `statusRef`, has the wallet that paid for it (`userAddress`)
 * sign the read-only session, then each recovery (after switchChain to its chain, when given), and
 * looks again after each until nothing is left. Every answer is checked before the wallet sees it
 * (RavnClient.recover: back to `userAddress` only); one session, and one recovery per kind, chain and
 * token. Resolves to what was sent back, before Hinkal's recovery fee: empty when nothing was stuck.
 * A failed payout's refund shows a few minutes after the failure, so an empty answer soon after it
 * is worth trying again later. Errors come as they are; nothing signed so far can move funds
 * anywhere but back to the wallet.
 */
export async function recoverStuckFunds(
  client: RavnClient,
  { statusRef, userAddress }: { statusRef: string; userAddress: string },
  handlers: RecoverHandlers
): Promise<{ recovered: Recovered }> {
  const recovered: Recovered = [];
  const signed = new Set<string>();
  const once = (key: string) => {
    if (signed.has(key)) throw new Error(`recoverStuckFunds: RAVN asked to sign ${key} a second time: nothing more was signed`);
    signed.add(key);
  };
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
      once("the session");
      signature = await handlers.signMessage(sign.message);
    } else {
      // checkRecovery held these to a recovery on a chain Hinkal runs on, of one token.
      const { primaryType, domain, message } = sign.typedData as { primaryType: string; domain: { chainId: number }; message: { tokenAddress: string } };
      once(`${primaryType} of ${message.tokenAddress.toLowerCase()} on chain ${domain.chainId}`);
      if (handlers.switchChain) await handlers.switchChain(domain.chainId);
      signature = await handlers.signTypedData(sign.typedData);
    }
    live();
    afterRecovery = sign.method === "eth_signTypedData_v4";
    answer = await ask({ authorization, signature });
  }
}
