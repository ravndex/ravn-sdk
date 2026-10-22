"""Hinkal's private swaps: the checks before the wallet signs or sends, and getting back what a
failed swap left at Hinkal (it never refunds on its own).

A mirror of @ravnexchange/sdk's Hinkal checks (core/src/guard.ts: checkAuthorize, the Hinkal deposit
in checkExecution, checkRecovery) and recoverStuckFunds (core/src/recover.ts): a compromised RAVN
answer can't get the paying wallet to sign or send anything that moves more than the swap, or pays
anyone but the swap's own recipient (or, on recovery, the wallet itself). Keep the two in step by hand.
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
NATIVE_EVM = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
# Hinkal.sol, the same address on every chain it runs on; RAVN's EVM fee wallet (guard-contracts.ts).
HINKAL = "0x7cb60446d7635c68edf1c568cac74a1f98c1cfa4"
RAVN_FEE_WALLET = "0x12d2425fd88c693edb4de004e0c747879b7d6933"
SEL_APPROVE, SEL_TRANSFER, SEL_DEPOSIT = "0x095ea7b3", "0xa9059cbb", "0xbb3b5d78"  # prooflessDeposit
MAX_FEE_BPS = 100
# RAVN offers a swap's recoveries on its source chain, one per stuck token: a handful at most.
MAX_RECOVERIES = 8


class UnsafeExecutionError(Exception):
    """An answer the paying wallet must not sign or send. Nothing was signed or sent."""

    code = "UNSAFE_EXECUTION"


def _dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _hinkal_sign(sign: Any) -> Optional[Dict[str, Any]]:
    """What a Hinkal step asks to sign (core/src/guard.ts hinkalSign): None for the read-only session
    personal_sign, else its typed data, checked to sign `primaryType` in Hinkal's enclave domain."""
    sign = _dict(sign)
    if sign.get("method") == "personal_sign":
        message = sign.get("message") if isinstance(sign.get("message"), str) else ""
        if HINKAL_NORMAL_MODE in message:
            raise UnsafeExecutionError("The message would open a Hinkal session that can move the user's funds")
        if not HINKAL_SESSION.fullmatch(message):
            raise UnsafeExecutionError("The message to sign isn't a read-only Hinkal session")
        return None
    if sign.get("method") != "eth_signTypedData_v4":
        raise UnsafeExecutionError("RAVN asked for a signature of a kind this SDK doesn't recognise")
    if not isinstance(sign.get("typedData"), dict):
        raise UnsafeExecutionError("The authorization's typed data is missing")
    typed = sign["typedData"]
    types = _dict(typed.get("types"))
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
    if [name for name in structs if name not in used] != [typed.get("primaryType")]:
        raise UnsafeExecutionError("The signature request's types sign something other than its primaryType")
    # Hinkal's domain names no contract: a field more would make the signature good somewhere else.
    domain = _dict(typed.get("domain"))
    if domain.get("name") != "Hinkal Enclave" or set(domain) - {"name", "chainId"}:
        raise UnsafeExecutionError("The signature request isn't for Hinkal's enclave")
    return typed


def _amount(value: Any, what: str) -> int:
    """A non-negative whole number: an int, or a decimal or 0x-hex string (core/src/guard.ts big)."""
    if type(value) is int and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{1,64}|[0-9]{1,78}", value):
        return int(value, 0) if value.startswith("0x") else int(value)
    raise UnsafeExecutionError(f"{what} isn't a whole number")


def _swap(intent: Dict[str, Any]) -> tuple:
    """(chain, input token lowercased, coin sell?, input amount) from what you asked /v1/quote for,
    held to what the check can hold (core/src/guard.ts context): a Hinkal chain, a token address."""
    chain = intent.get("inputChainId")
    if type(chain) is not int or chain not in HINKAL_CHAINS:
        raise UnsafeExecutionError(f"This SDK version doesn't know Hinkal on chain {chain}: update ravnexchange")
    token = intent.get("inputToken")
    if not isinstance(token, str) or not EVM_ADDRESS.fullmatch(token):
        raise UnsafeExecutionError("The quote's input token isn't an address: quote with token addresses (not symbols)")
    amount = _amount(intent.get("inputAmount"), "The swap's inputAmount")
    if amount <= 0:
        raise UnsafeExecutionError("The swap's input amount must be positive")
    return chain, token.lower(), token.lower() == NATIVE_EVM, amount


def _word(data: str, i: int) -> str:
    w = data[10 + 64 * i : 74 + 64 * i]
    if len(w) != 64:
        raise UnsafeExecutionError("Calldata is shorter than its function's arguments")
    return w


def _word_uint(data: str, i: int) -> int:
    return int(_word(data, i), 16)


def _word_address(data: str, i: int) -> str:
    w = _word(data, i)
    if not w.startswith("0" * 24):
        raise UnsafeExecutionError("Calldata argument isn't an address")
    return "0x" + w[24:]


def _call(call: Any, chain: int, what: str) -> tuple:
    """(to, data, value) of one EVM call, lowercased: on the swap's chain, to an address, hex data."""
    c = _dict(call)
    if type(c.get("chainId")) is not int or c["chainId"] != chain:
        raise UnsafeExecutionError(f"{what} isn't for the swap's chain {chain}")
    to, data = c.get("to"), c.get("data", "0x")
    if not isinstance(to, str) or not EVM_ADDRESS.fullmatch(to):
        raise UnsafeExecutionError(f"{what} has no valid recipient")
    if not isinstance(data, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})*", data):
        raise UnsafeExecutionError(f"{what}'s data isn't hex")
    return to.lower(), data.lower(), _amount(c.get("value", "0"), f"{what}'s value")


def check_hinkal_deposit(execution: Dict[str, Any], intent: Dict[str, Any]) -> None:
    """Raises UnsafeExecutionError unless the TRANSACTION after Hinkal's AUTHORIZE steps only pays the
    deposit (core/src/guard.ts checkExecution, Hinkal's case): Hinkal's prooflessDeposit of the input
    token alone (the zero address for the coin) for at most the input amount; on a token sell, an
    approve() of that token to Hinkal's contract for at most the input amount (and a reset to 0);
    RAVN's fee only to RAVN's fee wallet, at most 1% of the input; all of it within the input amount;
    and `calls`, when present, exactly those transactions in order. `intent` as for check_authorize.
    Not checked: which order or note a deposit funds, inside Hinkal's contract."""
    chain, token, native, amount = _swap(intent)
    ex = _dict(execution)
    if ex.get("executionType") != "TRANSACTION":
        raise UnsafeExecutionError("Not a TRANSACTION")
    if ex.get("sandbox"):
        raise UnsafeExecutionError("A sandbox execution: never send it")
    tx = _dict(ex.get("transaction"))
    if tx.get("serialized") or ex.get("submit"):
        raise UnsafeExecutionError("A Solana or submit-through-RAVN transaction was returned for Hinkal's deposit")
    to, data, value = _call(tx, chain, "The deposit")
    if to != HINKAL:
        raise UnsafeExecutionError("The transaction isn't a deposit into Hinkal's contract")
    if data[:10] != SEL_DEPOSIT:
        raise UnsafeExecutionError("The call to Hinkal isn't a deposit")

    def single(arg: int) -> int:
        offset = _word_uint(data, arg)
        if offset % 32:
            raise UnsafeExecutionError("Hinkal's deposit calldata isn't ABI-encoded")
        if _word_uint(data, offset // 32) != 1:
            raise UnsafeExecutionError("The Hinkal deposit isn't for exactly one token")
        return offset // 32 + 1

    if _word_address(data, single(0)) != (ZERO_ADDRESS if native else token):
        raise UnsafeExecutionError("The Hinkal deposit is for a token other than the one being swapped")
    pulled = _word_uint(data, single(1))
    if pulled > amount:
        raise UnsafeExecutionError("The Hinkal deposit is for more than the swap's amount")
    if not native and value != 0:
        raise UnsafeExecutionError("A token swap sends the native coin too")

    expected = []  # the transactions `calls` must be, in order
    approved = 0
    if ex.get("approval") is not None:
        if native:
            raise UnsafeExecutionError("An approval was asked for a swap paying in the native coin")
        approval = _dict(ex["approval"])
        steps = ([dict(_dict(approval.get("reset")), chainId=approval.get("chainId"))] if approval.get("reset") else []) + [approval]
        for i, a in enumerate(steps):
            ato, adata, avalue = _call(a, chain, "The approval")
            if ato != token:
                raise UnsafeExecutionError("An approval is for a token other than the one being swapped")
            if adata[:10] != SEL_APPROVE or len(adata) != 138 or avalue != 0:
                raise UnsafeExecutionError("The approval isn't a plain approve()")
            if _word_address(adata, 0) != HINKAL:
                raise UnsafeExecutionError("The approval is for a contract the swap doesn't call")
            approved = _word_uint(adata, 1)
            if i < len(steps) - 1 and approved != 0:
                raise UnsafeExecutionError("The approval reset isn't to zero")
            if approved > amount:
                raise UnsafeExecutionError("The approval is for more than the swap's amount")
            expected.append((ato, adata, avalue))
        # The fields describing it must say what its calldata says: an integrator may build from them.
        if approval.get("spender") is not None and str(approval["spender"]).lower() != HINKAL:
            raise UnsafeExecutionError("The approval's spender isn't the one its calldata approves")
        if _amount(approval.get("amount"), "The approval amount") != approved:
            raise UnsafeExecutionError("The approval's amount isn't the one its calldata approves")
        if approval.get("unlimitedRecommended"):
            raise UnsafeExecutionError("An unlimited approval is recommended for Hinkal's contract")
    expected.append((to, data, value))

    coin, tokens = value, max(approved, 0 if native else pulled)
    if ex.get("fee") is not None:
        fee = _dict(ex["fee"])
        if not isinstance(fee.get("address"), str) or fee["address"].lower() != RAVN_FEE_WALLET:
            raise UnsafeExecutionError("The fee doesn't go to RAVN's fee wallet")
        if fee.get("chainId") is not None and (type(fee["chainId"]) is not int or fee["chainId"] != chain):
            raise UnsafeExecutionError(f"The fee isn't for the swap's chain {chain}")
        cap = _amount(fee.get("amount"), "The fee")
        if cap > amount * MAX_FEE_BPS // 10_000:
            raise UnsafeExecutionError("The fee is more than 1% of the swap")
        if fee.get("transaction") is not None:
            fto, fdata, fvalue = _call(fee["transaction"], chain, "The fee payment")
            if fto == RAVN_FEE_WALLET:  # the coin itself, with a short tag as data
                if not native:
                    raise UnsafeExecutionError("A coin fee was asked on a token swap")
                if len(fdata) > 2 + 64 or fvalue > cap:
                    raise UnsafeExecutionError("The fee payment is more than the fee")
                coin += fvalue
            elif fto == token and fdata[:10] == SEL_TRANSFER:  # the token's transfer, with a trailing tag
                if _word_address(fdata, 0) != RAVN_FEE_WALLET:
                    raise UnsafeExecutionError("The fee transfer isn't to RAVN's fee wallet")
                if _word_uint(fdata, 1) > cap or len(fdata) > 138 + 64 or fvalue != 0:
                    raise UnsafeExecutionError("The fee payment is more than the fee")
                tokens += _word_uint(fdata, 1)
            else:
                raise UnsafeExecutionError("The fee payment isn't a payment to RAVN's fee wallet")
            expected.append((fto, fdata, fvalue))
    if coin > amount:
        raise UnsafeExecutionError("The swap sends more of the native coin than the swap's amount")
    if tokens > amount:
        raise UnsafeExecutionError("The swap and RAVN's fee take more of the token than the swap's amount")
    if ex.get("calls") is not None:
        calls = ex["calls"] if isinstance(ex["calls"], list) else [None]
        if [_call(c, chain, "A call") for c in calls] != expected:
            raise UnsafeExecutionError("The execution's calls aren't the transactions it describes")


def check_authorize(execution: Dict[str, Any], intent: Dict[str, Any]) -> None:
    """Raises UnsafeExecutionError unless a Hinkal AUTHORIZE step is one the paying wallet may sign
    (core/src/guard.ts checkAuthorize): step 1 a read-only Hinkal session; step 2 a PrivateSendBridge
    order in Hinkal's domain on the input chain, for the input token (the zero address for the coin),
    at most the input amount, paying exactly one recipient: your destinationAddress (without one,
    userAddress). `intent` is what you asked /v1/quote for, the same camelCase dict: inputChainId,
    inputToken, inputAmount, userAddress and destinationAddress. Not checked: the bridge route inside
    the order (`quote`), which Hinkal runs as given."""
    chain, token, native, amount = _swap(intent)
    if _dict(execution).get("executionType") != "AUTHORIZE":
        raise UnsafeExecutionError("Not an AUTHORIZE step")
    typed = _hinkal_sign(execution.get("sign"))
    if typed is None:
        return
    domain = _dict(typed.get("domain"))
    message = _dict(typed.get("message"))
    if type(domain.get("chainId")) is not int or domain.get("chainId") != chain:
        raise UnsafeExecutionError(f"The signature request isn't for the swap's chain {chain}")
    if typed.get("primaryType") != "PrivateSendBridge":
        raise UnsafeExecutionError("RAVN asked for a signature of a kind this SDK doesn't recognise")
    if type(message.get("chainId")) is not int or message.get("chainId") != chain:
        raise UnsafeExecutionError(f"The order isn't for the swap's chain {chain}")
    expected = ZERO_ADDRESS if native else token
    if not isinstance(message.get("tokenAddress"), str) or message["tokenAddress"].lower() != expected:
        raise UnsafeExecutionError("The order is for a token other than the one being swapped")
    recipients = message.get("recipients") if isinstance(message.get("recipients"), list) else []
    if len(recipients) != 1 or not isinstance(recipients[0], dict):
        raise UnsafeExecutionError("The order doesn't pay exactly one recipient")
    only = recipients[0]
    if _amount(only.get("amount"), "The order's amount") > amount:
        raise UnsafeExecutionError("The order sends more than the swap's amount")
    # No destination asked: the user's own wallet, as for any order. `or`, not TS's `??`: the API reads
    # an empty destinationAddress as not supplied, so the order then pays userAddress.
    payee = intent.get("destinationAddress") or intent.get("userAddress") or ""
    recipient = only.get("recipient")
    same = isinstance(payee, str) and payee != "" and isinstance(recipient, str) and (recipient.lower() == payee.lower() if EVM_ADDRESS.fullmatch(payee) else recipient == payee)
    if not same:
        raise UnsafeExecutionError("The order pays someone other than the destination address")


def check_recovery(answer: Dict[str, Any], user_address: str) -> None:
    """Raises UnsafeExecutionError unless `answer` is one `user_address`, the wallet that paid for
    the swap, may sign: a read-only Hinkal session, or a recovery (RecoverStuckBridgeBalance /
    WithdrawStuckUtxos) on a chain Hinkal runs on that sends one token back to that same wallet."""
    status = _dict(answer).get("status")
    if status in ("nothing", "done"):
        return
    if status != "sign":
        raise UnsafeExecutionError(f"Can't check a recovery answer of status {status!r}: update ravnexchange")
    typed = _hinkal_sign(answer.get("sign"))
    if typed is None:
        return
    types = _dict(typed.get("types"))
    primary = typed.get("primaryType")
    if primary not in ("RecoverStuckBridgeBalance", "WithdrawStuckUtxos"):
        raise UnsafeExecutionError("RAVN asked for a signature of a kind this SDK doesn't recognise")
    fields = types[primary] if isinstance(types[primary], list) else []
    if [f"{_dict(f).get('name')}:{_dict(f).get('type')}" for f in fields] != RECOVERY_FIELDS:
        raise UnsafeExecutionError("The signature request signs other fields than its kind's")
    domain = _dict(typed.get("domain"))
    message = _dict(typed.get("message"))
    chain = domain.get("chainId")
    # type() is int, not ==: True == 1 and 8453.0 == 8453 in Python.
    if type(chain) is not int or chain not in HINKAL_CHAINS or type(message.get("chainId")) is not int or message.get("chainId") != chain:
        raise UnsafeExecutionError("The recovery isn't for a chain Hinkal runs on")
    if not isinstance(message.get("tokenAddress"), str) or not EVM_ADDRESS.fullmatch(message["tokenAddress"]):
        raise UnsafeExecutionError("The recovery names no token")
    recipient = message.get("recipient")
    if not EVM_ADDRESS.fullmatch(user_address or "") or not isinstance(recipient, str) or recipient.lower() != user_address.lower():
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
