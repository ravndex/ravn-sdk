"""Getting back what a failed Hinkal swap left at Hinkal (it never refunds on its own).

A mirror of @ravnexchange/sdk's checkRecovery (core/src/guard.ts) and recoverStuckFunds
(core/src/recover.ts): every /v1/recover answer is checked to send funds back to the wallet that
paid, and nowhere else, before that wallet is asked to sign it. Keep the two in step by hand.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

if TYPE_CHECKING:
    from .client import RavnClient

# Ethereum, BNB Chain, Polygon, Robinhood Chain, Base, Arbitrum: the chains Hinkal runs on.
HINKAL_CHAINS = (1, 56, 137, 4663, 8453, 42161)
# Read-only mode. Hinkal's normal mode adds HINKAL_NORMAL_MODE: that session's key can move funds.
HINKAL_SESSION = re.compile(r"Authorize Hinkal session\nSession ID: [0-9a-f-]{36}\nPublic Key: 0[23][0-9a-f]{64}")
HINKAL_NORMAL_MODE = "This signature can also be used to submit transactions."
# Hinkal's own field list for both recoveries (its enclave rebuilds it): `recipient` is signed.
RECOVERY_FIELDS = ["nonce:string", "sessionId:string", "chainId:uint256", "tokenAddress:address", "recipient:address"]
EVM_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
# RAVN offers a swap's recoveries on its source chain, one per stuck token: a handful at most.
MAX_RECOVERIES = 8


class UnsafeExecutionError(Exception):
    """A /v1/recover answer the paying wallet must not sign. Nothing was signed."""

    code = "UNSAFE_EXECUTION"


def _dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def check_recovery(answer: Dict[str, Any], user_address: str) -> None:
    """Raises UnsafeExecutionError unless `answer` is one `user_address`, the wallet that paid for
    the swap, may sign: a read-only Hinkal session, or a recovery (RecoverStuckBridgeBalance /
    WithdrawStuckUtxos) on a chain Hinkal runs on that sends one token back to that same wallet."""
    status = _dict(answer).get("status")
    if status in ("nothing", "done"):
        return
    if status != "sign":
        raise UnsafeExecutionError(f"Can't check a recovery answer of status {status!r}: update ravnexchange")
    sign = _dict(answer.get("sign"))
    if sign.get("method") == "personal_sign":
        message = sign.get("message") if isinstance(sign.get("message"), str) else ""
        if HINKAL_NORMAL_MODE in message:
            raise UnsafeExecutionError("The message would open a Hinkal session that can move the user's funds")
        if not HINKAL_SESSION.fullmatch(message):
            raise UnsafeExecutionError("The message to sign isn't a read-only Hinkal session")
        return
    if sign.get("method") != "eth_signTypedData_v4":
        raise UnsafeExecutionError("RAVN asked for a signature of a kind this SDK doesn't recognise")
    typed = _dict(sign.get("typedData"))
    types = _dict(typed.get("types"))
    primary = typed.get("primaryType")
    # A wallet signs the one struct no other references, whatever primaryType says.
    structs = [name for name in types if name != "EIP712Domain"]
    # Only a string type can name a struct; \Z and [0-9], not $ and \d: no trailing newline, ASCII digits.
    used = {
        re.sub(r"(\[[0-9]*\])+\Z", "", t)
        for name in structs
        for f in (types[name] if isinstance(types[name], list) else [])
        for t in [_dict(f).get("type")]
        if isinstance(t, str)
    }
    if [name for name in structs if name not in used] != [primary]:
        raise UnsafeExecutionError("The signature request's types sign something other than its primaryType")
    if primary not in ("RecoverStuckBridgeBalance", "WithdrawStuckUtxos"):
        raise UnsafeExecutionError("RAVN asked for a signature of a kind this SDK doesn't recognise")
    fields = types[primary] if isinstance(types[primary], list) else []
    if [f"{_dict(f).get('name')}:{_dict(f).get('type')}" for f in fields] != RECOVERY_FIELDS:
        raise UnsafeExecutionError("The signature request signs other fields than its kind's")
    domain = _dict(typed.get("domain"))
    message = _dict(typed.get("message"))
    # Hinkal's domain names no contract: a field more would make the signature good somewhere else.
    if domain.get("name") != "Hinkal Enclave" or set(domain) - {"name", "chainId"}:
        raise UnsafeExecutionError("The signature request isn't for Hinkal's enclave")
    chain = domain.get("chainId")
    # type() is int, not ==: True == 1 and 8453.0 == 8453 in Python.
    if type(chain) is not int or chain not in HINKAL_CHAINS or type(message.get("chainId")) is not int or message.get("chainId") != chain:
        raise UnsafeExecutionError("The recovery isn't for a chain Hinkal runs on")
    if not EVM_ADDRESS.fullmatch(str(message.get("tokenAddress"))):
        raise UnsafeExecutionError("The recovery names no token")
    if not EVM_ADDRESS.fullmatch(user_address or "") or str(message.get("recipient")).lower() != user_address.lower():
        raise UnsafeExecutionError("The recovery sends the funds to someone other than the signing wallet")


def _live(expires_at: str) -> None:
    try:
        live = datetime.fromisoformat(expires_at.replace("Z", "+00:00")) > datetime.now(timezone.utc)
    except (AttributeError, TypeError, ValueError):  # TypeError: a time with no zone
        live = False
    if not live:
        raise ValueError("recover_stuck_funds: the signature request expired: start the recovery again")


def recover_stuck_funds(
    client: "RavnClient",
    status_ref: str,
    user_address: str,
    sign_message: Callable[[str], str],
    sign_typed_data: Callable[[Dict[str, Any]], str],
    switch_chain: Optional[Callable[[int], Any]] = None,
) -> List[Dict[str, Any]]:
    """Gets back everything a failed Hinkal swap left at Hinkal: has the wallet that paid for it
    (`user_address`, from your own wallet connection, never from a RAVN answer) sign the read-only
    session, then each recovery (after switch_chain to its chain, when given), looking again after
    each until nothing is left. `sign_message` personal_signs a message; `sign_typed_data` signs
    EIP-712 typed data (eth_signTypedData_v4); each returns the 0x signature. Every answer is checked
    first (check_recovery). One session per run and up to 8 recoveries, all on one chain, each kind
    and token once: offered one again, it stops there. Returns what was sent back, amounts before
    Hinkal's recovery fee: empty when nothing was stuck (a failed payout's refund shows a few minutes
    after the failure, so try again later). A recovery is public: an ordinary on-chain payment back
    to the paying wallet, which can link it to the wallet it was paying."""
    recovered: List[Dict[str, Any]] = []
    signed = set()
    chain: Optional[int] = None
    recoveries = 0

    def ask(**more: str) -> Dict[str, Any]:
        return client.recover({"statusRef": status_ref, **more}, user_address)

    answer = ask()
    # "done" answers a recovery's signature only: anything else asking to look again is refused.
    after_recovery = False
    while True:
        if answer["status"] == "nothing":
            return recovered
        if answer["status"] == "done":
            if not after_recovery:
                raise ValueError("recover_stuck_funds: RAVN said done without a recovery being signed")
            recovered.extend(answer.get("recovered") or [])
            after_recovery = False
            answer = ask(authorization=answer["authorization"])
            continue
        sign = answer["sign"]
        _live(answer.get("expiresAt"))
        if sign["method"] == "personal_sign":
            if "session" in signed:
                raise ValueError("recover_stuck_funds: RAVN asked to sign the session a second time: nothing more was signed")
            signed.add("session")
            signature = sign_message(sign["message"])
        else:
            # check_recovery held these to a recovery on a chain Hinkal runs on, of one token.
            typed = sign["typedData"]
            chain_id = typed["domain"]["chainId"]
            key = f"{typed['primaryType']}:{chain_id}:{str(typed['message']['tokenAddress']).lower()}"
            if key in signed:
                return recovered
            if chain is not None and chain_id != chain:
                raise ValueError(
                    f"recover_stuck_funds: RAVN asked for a recovery on chain {chain_id} after one on chain {chain}: a swap's are all on its source chain"
                )
            if recoveries == MAX_RECOVERIES:
                raise ValueError(f"recover_stuck_funds: RAVN asked for more than {MAX_RECOVERIES} recoveries: nothing more was signed")
            recoveries += 1
            signed.add(key)
            chain = chain_id
            if switch_chain:
                switch_chain(chain_id)
            signature = sign_typed_data(typed)
        _live(answer.get("expiresAt"))
        after_recovery = sign["method"] == "eth_signTypedData_v4"
        answer = ask(authorization=answer["authorization"], signature=signature)
