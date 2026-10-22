"""check_recovery and recover_stuck_funds, against the same answers as core/src/hinkal.test.ts."""

import copy
import json
import time
import unittest
from datetime import datetime, timedelta, timezone

from ravnexchange import RavnClient, UnsafeExecutionError, check_authorize, check_hinkal_deposit, check_recovery, recover_stuck_funds

USER = "0x1111111111111111111111111111111111111111"
ATTACKER = "0x9999999999999999999999999999999999999999"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
OTHER = "0x4200000000000000000000000000000000000006"
SESSION = "Authorize Hinkal session\nSession ID: 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b\nPublic Key: 02" + "ab" * 32
LATER = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")


def recovery_typed(kind, **over):
    message = {"nonce": "n-1", "sessionId": "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b", "chainId": 8453, "tokenAddress": USDC, "recipient": USER}
    message.update(over)
    return {
        "domain": {"name": "Hinkal Enclave", "chainId": 8453},
        "types": {
            "EIP712Domain": [{"name": "name", "type": "string"}, {"name": "chainId", "type": "uint256"}],
            kind: [
                {"name": "nonce", "type": "string"},
                {"name": "sessionId", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "tokenAddress", "type": "address"},
                {"name": "recipient", "type": "address"},
            ],
        },
        "primaryType": kind,
        "message": message,
    }


def session(authorization="r-1"):
    return {"status": "sign", "authorization": authorization, "sign": {"method": "personal_sign", "message": SESSION}, "expiresAt": LATER, "step": 1}


def recovering(typed, authorization="r-2"):
    return {"status": "sign", "authorization": authorization, "sign": {"method": "eth_signTypedData_v4", "typedData": typed}, "expiresAt": LATER, "step": 2}


def done(token, authorization):
    return {"status": "done", "recovered": [{"chainId": 8453, "tokenAddress": token, "amount": "1000"}], "authorization": authorization}


class FakeResponse:
    def __init__(self, body):
        self.status = 200
        self._body = json.dumps(body).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None


def client_answering(answers, sent):
    queue = list(answers)

    def _urlopen(req):
        sent.append(json.loads(req.data))
        return FakeResponse({"data": queue.pop(0)})

    return RavnClient(urlopen=_urlopen)


class CheckRecoveryTest(unittest.TestCase):
    def refuses(self, answer, message, user=USER):
        with self.assertRaisesRegex(UnsafeExecutionError, message):
            check_recovery(answer, user)

    def test_accepts_the_session_both_recoveries_done_and_nothing(self):
        check_recovery(session(), USER)
        check_recovery(recovering(recovery_typed("RecoverStuckBridgeBalance")), USER)
        check_recovery(recovering(recovery_typed("WithdrawStuckUtxos")), "0x" + USER[2:].upper())
        check_recovery(done(USDC, "r-3"), USER)
        check_recovery({"status": "nothing"}, USER)

    def test_refuses_a_recovery_to_anyone_but_the_signing_wallet(self):
        self.refuses(recovering(recovery_typed("RecoverStuckBridgeBalance", recipient=ATTACKER)), "someone other than the signing wallet")
        self.refuses(recovering(recovery_typed("WithdrawStuckUtxos")), "someone other than the signing wallet", ATTACKER)
        self.refuses(recovering(recovery_typed("WithdrawStuckUtxos")), "someone other than the signing wallet", "")

    def test_refuses_normal_mode_another_kind_or_other_fields(self):
        normal = session()
        normal["sign"]["message"] = SESSION + "\nThis signature can also be used to submit transactions."
        self.refuses(normal, "can move the user's funds")
        renamed = recovery_typed("RecoverStuckBridgeBalance")
        renamed["types"]["Withdraw"] = renamed["types"].pop("RecoverStuckBridgeBalance")
        renamed["primaryType"] = "Withdraw"
        self.refuses(recovering(renamed), "kind this SDK doesn't recognise")
        as_text = recovery_typed("WithdrawStuckUtxos")
        as_text["types"]["WithdrawStuckUtxos"][4] = {"name": "recipient", "type": "string"}
        self.refuses(recovering(as_text), "signs other fields than its kind's")
        rooted = recovery_typed("WithdrawStuckUtxos")
        rooted["types"]["Extra"] = [{"name": "x", "type": "uint256"}]
        self.refuses(recovering(rooted), "something other than its primaryType")
        # A second root hidden behind a type Python would read as its name: refused like the TS check.
        for name, field in [("None", {"name": "x", "type": None}), ("", {"name": "x"}), ("Extra", {"name": "x", "type": "Extra[٣]"}), ("X\n", {"name": "x", "type": "X[]\n"})]:
            hidden = recovery_typed("WithdrawStuckUtxos")
            hidden["types"][name] = [field]
            self.refuses(recovering(hidden), "something other than its primaryType")
        for message in [SESSION + "\n", SESSION + "\nx"]:
            extended = session()
            extended["sign"]["message"] = message
            self.refuses(extended, "isn't a read-only Hinkal session")

    def test_refuses_another_domain_or_chain(self):
        contract = recovery_typed("WithdrawStuckUtxos")
        contract["domain"]["verifyingContract"] = USDC
        self.refuses(recovering(contract), "isn't for Hinkal's enclave")
        renamed = recovery_typed("WithdrawStuckUtxos")
        renamed["domain"]["name"] = "Other"
        self.refuses(recovering(renamed), "isn't for Hinkal's enclave")
        self.refuses(recovering(recovery_typed("WithdrawStuckUtxos", recipient="")), "someone other than the signing wallet", "")
        optimism = recovery_typed("WithdrawStuckUtxos", chainId=10)
        optimism["domain"]["chainId"] = 10
        self.refuses(recovering(optimism), "isn't for a chain Hinkal runs on")
        self.refuses(recovering(recovery_typed("WithdrawStuckUtxos", chainId=1)), "isn't for a chain Hinkal runs on")
        self.refuses(recovering(recovery_typed("WithdrawStuckUtxos", tokenAddress="usdc")), "names no token")
        self.refuses(recovering(recovery_typed("WithdrawStuckUtxos", tokenAddress=USDC + "00")), "names no token")
        for chain in [True, 8453.0]:
            loose = recovery_typed("WithdrawStuckUtxos")
            loose["domain"]["chainId"] = chain
            self.refuses(recovering(loose), "isn't for a chain Hinkal runs on")
        ethereum = recovery_typed("WithdrawStuckUtxos", chainId=True)
        ethereum["domain"]["chainId"] = 1
        self.refuses(recovering(ethereum), "isn't for a chain Hinkal runs on")
        self.refuses({"status": "refund"}, "update ravnexchange")


DEST = "0x2222222222222222222222222222222222222222"
INTENT = {"inputChainId": 8453, "inputToken": USDC, "inputAmount": "20000000", "userAddress": USER, "destinationAddress": DEST}


def order(token=USDC, amount="19900000", recipients=None):
    return {
        "domain": {"name": "Hinkal Enclave", "chainId": 8453},
        "types": {
            "EIP712Domain": [{"name": "name", "type": "string"}, {"name": "chainId", "type": "uint256"}],
            "BridgeRecipientAmount": [{"name": "recipient", "type": "string"}, {"name": "amount", "type": "int256"}],
            "PrivateSendBridge": [
                {"name": "nonce", "type": "string"},
                {"name": "sessionId", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "tokenAddress", "type": "address"},
                {"name": "destinationChainId", "type": "uint256"},
                {"name": "destinationTokenAddress", "type": "string"},
                {"name": "recipients", "type": "BridgeRecipientAmount[]"},
                {"name": "quote", "type": "string"},
            ],
        },
        "primaryType": "PrivateSendBridge",
        "message": {
            "nonce": "5d0c3a8e-0000-4000-8000-000000000001",
            "sessionId": "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b",
            "chainId": 8453,
            "tokenAddress": token,
            "destinationChainId": 42161,
            "destinationTokenAddress": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
            "recipients": [{"recipient": DEST, "amount": amount}] if recipients is None else recipients,
            "quote": "route",
        },
    }


def step(sign):
    return {"executionType": "AUTHORIZE", "quoteToken": "qt-1", "authorization": "hk_" + "0" * 32, "sign": sign, "expiresAt": LATER, "step": 1, "steps": 2}


def placing(typed):
    return step({"method": "eth_signTypedData_v4", "typedData": typed})


class CheckAuthorizeTest(unittest.TestCase):
    def refuses(self, execution, message, intent=INTENT):
        with self.assertRaisesRegex(UnsafeExecutionError, message):
            check_authorize(execution, intent)

    def test_accepts_the_session_and_an_order_for_a_token_or_the_coin(self):
        check_authorize(step({"method": "personal_sign", "message": SESSION}), INTENT)
        check_authorize(placing(order()), INTENT)
        check_authorize(placing(order(recipients=[{"recipient": DEST.upper().replace("0X", "0x"), "amount": 19900000}])), INTENT)
        coin = dict(INTENT, inputToken="0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", inputAmount="10000000000000000")
        check_authorize(placing(order(token="0x0000000000000000000000000000000000000000", amount="9900000000000000")), coin)
        # No destination asked: the order pays the user's own wallet.
        check_authorize(placing(order(recipients=[{"recipient": USER, "amount": "1"}])), dict(INTENT, destinationAddress=""))

    def test_refuses_a_session_that_can_move_funds(self):
        self.refuses(step({"method": "personal_sign", "message": SESSION + "\nThis signature can also be used to submit transactions."}), "can move the user's funds")
        self.refuses(step({"method": "personal_sign", "message": "Sign in"}), "isn't a read-only Hinkal session")

    def test_refuses_an_order_paying_anyone_else_or_more_than_the_swap(self):
        self.refuses(placing(order(recipients=[{"recipient": ATTACKER, "amount": "1"}])), "someone other than the destination")
        self.refuses(placing(order(recipients=[{"recipient": [DEST], "amount": "1"}])), "someone other than the destination")
        self.refuses(placing(order(recipients=[{"recipient": DEST, "amount": "1"}, {"recipient": ATTACKER, "amount": "1"}])), "exactly one recipient")
        self.refuses(placing(order(recipients=[])), "exactly one recipient")
        self.refuses(placing(order(amount="20000001")), "more than the swap's amount")
        self.refuses(placing(order(amount="-1")), "isn't a whole number")
        self.refuses(placing(order(amount=True)), "isn't a whole number")

    def test_refuses_another_token_chain_kind_or_domain(self):
        self.refuses(placing(order(token=OTHER)), "token other than the one being swapped")
        other_chain = order()
        other_chain["message"]["chainId"] = 42161
        self.refuses(placing(other_chain), "order isn't for the swap's chain")
        loose = order()
        loose["domain"]["chainId"] = True
        self.refuses(placing(loose), "signature request isn't for the swap's chain")
        contract = order()
        contract["domain"]["verifyingContract"] = USDC
        self.refuses(placing(contract), "isn't for Hinkal's enclave")
        renamed = order()
        renamed["types"]["Permit"] = renamed["types"].pop("PrivateSendBridge")
        renamed["primaryType"] = "Permit"
        self.refuses(placing(renamed), "kind this SDK doesn't recognise")
        rooted = order()
        rooted["types"]["Extra"] = [{"name": "x", "type": "uint256"}]
        self.refuses(placing(rooted), "something other than its primaryType")
        self.refuses(step({"method": "eth_signTypedData_v4"}), "typed data is missing")
        self.refuses(placing(order()), "doesn't know Hinkal on chain 10", dict(INTENT, inputChainId=10))
        self.refuses(dict(placing(order()), executionType="TRANSACTION"), "Not an AUTHORIZE step")
        arbitrum = order()
        arbitrum["domain"]["chainId"] = 42161
        self.refuses(placing(arbitrum), "signature request isn't for the swap's chain")
        for chain in [8453.0, True]:
            loose = order()
            loose["message"]["chainId"] = chain
            self.refuses(placing(loose), "order isn't for the swap's chain")
        self.refuses(placing(order()), "doesn't know Hinkal on chain", dict(INTENT, inputChainId=8453.0))
        self.refuses(placing(order(amount=-1)), "isn't a whole number")
        self.refuses(placing(order(recipients=["0x2222222222222222222222222222222222222222"])), "exactly one recipient")
        self.refuses(step({"method": "eth_sign", "typedData": order()}), "kind this SDK doesn't recognise")
        self.refuses(placing(order(recipients=[{"recipient": "", "amount": "1"}])), "someone other than the destination", dict(INTENT, destinationAddress="", userAddress=""))
        self.refuses(placing(order()), "isn't an address", dict(INTENT, inputToken="USDC"))
        self.refuses(placing(order(amount="0")), "must be positive", dict(INTENT, inputAmount="0"))

    def test_a_solana_destination_is_compared_exactly(self):
        solana = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
        check_authorize(placing(order(recipients=[{"recipient": solana, "amount": "1"}])), dict(INTENT, destinationAddress=solana))
        self.refuses(placing(order(recipients=[{"recipient": solana.lower(), "amount": "1"}])), "someone other than the destination", dict(INTENT, destinationAddress=solana))


HINKAL = "0x7cb60446d7635C68EDf1c568cac74A1f98c1Cfa4"
FEE_WALLET = "0x12d2425fD88c693EDB4dE004E0c747879B7D6933"
NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
ZERO = "0x0000000000000000000000000000000000000000"
DEPOSIT_INTENT = dict(INTENT, inputAmount="100000000")
COIN_INTENT = dict(DEPOSIT_INTENT, inputToken=NATIVE, inputAmount="1000000000000000000")
AMOUNT_IN, FEE = 99_400_000, 500_000


def word(v):
    return (format(v, "x") if isinstance(v, int) else v[2:].lower()).rjust(64, "0")


def approve(spender, amount):
    return "0x095ea7b3" + word(spender) + word(amount)


def transfer(to, amount):
    return "0xa9059cbb" + word(to) + word(amount)


def deposit(token, amount, selector="0xbb3b5d78"):
    # prooflessDeposit([token], [amount], [(1,2,3,4,5)], [0xabcd], true, "order-123"), as viem encodes it.
    args = [0xC0, 0x100, 0x140, 0x200, 1, 0x280, 1, token, 1, amount, 1, 1, 2, 3, 4, 5, 1, 0x20, 2]
    return selector + "".join(word(a) for a in args) + "abcd".ljust(64, "0") + word(9) + b"order-123".hex().ljust(64, "0")


def token_sell():
    approval = {"to": USDC, "data": approve(HINKAL, AMOUNT_IN), "value": "0", "chainId": 8453, "spender": HINKAL, "amount": str(AMOUNT_IN)}
    transaction = {"to": HINKAL, "data": deposit(USDC, AMOUNT_IN), "value": "0", "chainId": 8453}
    fee = {"to": USDC, "data": transfer(FEE_WALLET, FEE) + word("0x5a"), "value": "0", "chainId": 8453}
    return {
        "executionType": "TRANSACTION",
        "quoteToken": "qt-2",
        "approval": approval,
        "transaction": transaction,
        "fee": {"amount": str(FEE), "address": FEE_WALLET, "chainId": 8453, "transaction": fee},
        "calls": [{"to": USDC, "data": approval["data"], "value": "0", "chainId": 8453}, dict(transaction), dict(fee)],
        "batch": True,
    }


def coin_sell(value=990_000_000_000_000_000):
    return {"executionType": "TRANSACTION", "quoteToken": "qt-2", "transaction": {"to": HINKAL, "data": deposit(ZERO, value), "value": str(value), "chainId": 8453}}


def with_tx(**change):
    e = token_sell()
    e["transaction"].update(change)
    e.pop("calls")
    return e


class CheckHinkalDepositTest(unittest.TestCase):
    def refuses(self, execution, message, intent=DEPOSIT_INTENT):
        with self.assertRaisesRegex(UnsafeExecutionError, message):
            check_hinkal_deposit(execution, intent)

    def test_accepts_a_token_sell_and_a_coin_sell(self):
        check_hinkal_deposit(token_sell(), DEPOSIT_INTENT)
        check_hinkal_deposit(coin_sell(), COIN_INTENT)
        coin_fee = coin_sell(980_000_000_000_000_000)
        coin_fee["fee"] = {"amount": "10000000000000000", "address": FEE_WALLET, "chainId": 8453,
                           "transaction": {"to": FEE_WALLET, "data": "0x" + word("0x5a"), "value": "10000000000000000", "chainId": 8453}}
        check_hinkal_deposit(coin_fee, COIN_INTENT)
        reset = token_sell()
        reset["approval"]["reset"] = {"to": USDC, "data": approve(HINKAL, 0), "value": "0"}
        reset["calls"].insert(0, {"to": USDC, "data": approve(HINKAL, 0), "value": "0", "chainId": 8453})
        check_hinkal_deposit(reset, DEPOSIT_INTENT)

    def test_refuses_a_deposit_that_isnt_hinkals_for_the_input(self):
        self.refuses(with_tx(to=ATTACKER), "isn't a deposit into Hinkal's contract")
        self.refuses(with_tx(data=deposit(USDC, AMOUNT_IN, "0x12345678")), "isn't a deposit")
        self.refuses(with_tx(data=deposit(OTHER, AMOUNT_IN)), "token other than the one being swapped")
        self.refuses(with_tx(data=deposit(USDC, 100_000_001)), "more than the swap's amount")
        two = deposit(USDC, AMOUNT_IN)
        two = two[: 10 + 64 * 6] + word(2) + two[10 + 64 * 7 :]
        self.refuses(with_tx(data=two), "exactly one token")
        self.refuses(with_tx(data="0xbb3b5d78" + word(0xC1)), "isn't ABI-encoded")
        self.refuses(with_tx(data="0xbb3b5d78" + word(0xC0)), "shorter than its function's arguments")
        self.refuses(with_tx(value="1"), "sends the native coin too")
        self.refuses(with_tx(chainId=1), "isn't for the swap's chain")
        self.refuses(with_tx(chainId=True), "isn't for the swap's chain")
        self.refuses(coin_sell(1_000_000_000_000_000_001), "more than the swap's amount", COIN_INTENT)
        self.refuses(coin_sell(), "token other than the one being swapped")
        self.refuses(dict(coin_sell(), sandbox=True), "never send it", COIN_INTENT)
        self.refuses(token_sell(), "isn't an address", dict(DEPOSIT_INTENT, inputToken="USDC"))
        self.refuses(token_sell(), "must be positive", dict(DEPOSIT_INTENT, inputAmount="0"))

    def test_refuses_an_approval_beyond_the_deposit(self):
        for change, message in [
            ({"to": OTHER, "data": approve(HINKAL, AMOUNT_IN)}, "token other than the one being swapped"),
            ({"data": approve(ATTACKER, AMOUNT_IN), "spender": ATTACKER}, "contract the swap doesn't call"),
            ({"data": approve(HINKAL, 100_000_001), "amount": "100000001"}, "more than the swap's amount"),
            ({"spender": ATTACKER}, "spender isn't the one its calldata approves"),
            ({"amount": "1"}, "amount isn't the one its calldata approves"),
            ({"data": approve(HINKAL, AMOUNT_IN) + "00"}, "isn't a plain approve"),
            ({"unlimitedRecommended": True}, "unlimited approval"),
        ]:
            e = token_sell()
            e["approval"].update(change)
            e.pop("calls")
            self.refuses(e, message)
        bad_reset = token_sell()
        bad_reset["approval"]["reset"] = {"to": USDC, "data": approve(HINKAL, 1), "value": "0"}
        bad_reset.pop("calls")
        self.refuses(bad_reset, "reset isn't to zero")
        coin_approval = coin_sell()
        coin_approval["approval"] = token_sell()["approval"]
        self.refuses(coin_approval, "native coin", COIN_INTENT)

    def test_refuses_a_fee_to_anyone_but_ravn_or_over_one_percent(self):
        for fee_change, message in [
            ({"address": ATTACKER}, "doesn't go to RAVN's fee wallet"),
            ({"amount": "1000001"}, "more than 1% of the swap"),
            ({"chainId": 1}, "fee isn't for the swap's chain"),
        ]:
            e = token_sell()
            e["fee"].update(fee_change)
            self.refuses(e, message)
        for tx_change, message in [
            ({"data": transfer(ATTACKER, FEE)}, "isn't to RAVN's fee wallet"),
            ({"data": transfer(FEE_WALLET, FEE + 1)}, "more than the fee"),
            ({"to": OTHER}, "isn't a payment to RAVN's fee wallet"),
            ({"to": FEE_WALLET, "data": "0x", "value": str(FEE)}, "coin fee was asked on a token swap"),
        ]:
            e = token_sell()
            e["fee"]["transaction"].update(tx_change)
            e.pop("calls")
            self.refuses(e, message)
        over = token_sell()  # each within its own limit, together more than the input
        over["approval"].update({"data": approve(HINKAL, 99_600_000), "amount": "99600000"})
        over.pop("calls")
        self.refuses(over, "take more of the token than the swap's amount")
        coin_over = coin_sell()
        coin_over["fee"] = {"amount": "10000000000000000", "address": FEE_WALLET, "chainId": 8453,
                            "transaction": {"to": FEE_WALLET, "data": "0x", "value": "10000000000000001", "chainId": 8453}}
        self.refuses(coin_over, "more than the fee", COIN_INTENT)

    def test_refuses_calls_that_arent_the_transactions_described(self):
        extra = token_sell()
        extra["calls"].append({"to": USDC, "data": transfer(ATTACKER, 1), "value": "0", "chainId": 8453})
        self.refuses(extra, "calls aren't the transactions it describes")
        swapped = token_sell()
        swapped["calls"][1] = dict(swapped["calls"][1], data=deposit(USDC, 1))
        self.refuses(swapped, "calls aren't the transactions it describes")
        self.refuses(dict(token_sell(), calls="0x"), "isn't for the swap's chain")

    def test_more_refusals_each_check_needs(self):
        # On a coin sell the total is the only bound on what the deposit sends.
        two_eth = coin_sell()
        two_eth["transaction"]["value"] = "2000000000000000000"
        self.refuses(two_eth, "more of the native coin than the swap's amount", COIN_INTENT)
        coin_fee = coin_sell()  # 0.99 deposited + 0.02 fee: over the 1 ETH input
        coin_fee["fee"] = {"amount": "10000000000000000", "address": FEE_WALLET, "chainId": 8453,
                           "transaction": {"to": FEE_WALLET, "data": "0x", "value": "10000000000000000", "chainId": 8453}}
        coin_fee["transaction"]["value"] = "1000000000000000000"
        self.refuses(coin_fee, "more of the native coin than the swap's amount", COIN_INTENT)
        tagged = coin_sell(980_000_000_000_000_000)
        tagged["fee"] = dict(coin_fee["fee"], transaction=dict(coin_fee["fee"]["transaction"], data="0x" + "00" * 33))
        self.refuses(tagged, "more than the fee", COIN_INTENT)
        check_hinkal_deposit(coin_sell(), COIN_INTENT)
        eeee = coin_sell()
        eeee["transaction"]["data"] = deposit(NATIVE, 990_000_000_000_000_000)
        self.refuses(eeee, "token other than the one being swapped", COIN_INTENT)
        for change, message in [({"data": transfer(HINKAL, AMOUNT_IN)}, "isn't a plain approve"), ({"value": "1"}, "isn't a plain approve")]:
            e = token_sell()
            e["approval"].update(change)
            e.pop("calls")
            self.refuses(e, message)
        empty_reset = token_sell()
        empty_reset["approval"]["reset"] = {}
        self.refuses(empty_reset, "no valid recipient")
        # Deposit-side half of the token total: approval 1, deposit 99.6M, fee 0.5M.
        deposit_side = token_sell()
        deposit_side["approval"].update({"data": approve(HINKAL, 1), "amount": "1"})
        deposit_side["transaction"]["data"] = deposit(USDC, 99_600_000)
        deposit_side.pop("calls")
        self.refuses(deposit_side, "take more of the token than the swap's amount")
        for tx_change in [{"value": "1"}, {"data": transfer(FEE_WALLET, FEE) + "00" * 33}]:
            e = token_sell()
            e["fee"]["transaction"].update(tx_change)
            e.pop("calls")
            self.refuses(e, "more than the fee")
        dirty = with_tx(data=deposit(USDC, AMOUNT_IN))
        dirty["transaction"]["data"] = dirty["transaction"]["data"][: 10 + 64 * 7] + "ff" + dirty["transaction"]["data"][12 + 64 * 7 :]
        self.refuses(dirty, "isn't an address")
        self.refuses(dict(token_sell(), executionType="DEPOSIT"), "Not a TRANSACTION")
        self.refuses(dict(token_sell(), transaction=dict(token_sell()["transaction"], serialized="AQ==")), "Solana or submit")
        self.refuses(dict(token_sell(), submit={"url": "/api/v1/submit-transaction"}), "Solana or submit")
        for where in ["fee", "call"]:
            e = token_sell()
            if where == "fee":
                e["fee"]["chainId"] = 8453.0
                self.refuses(e, "fee isn't for the swap's chain")
            else:
                e["calls"][0]["chainId"] = 8453.0
                self.refuses(e, "A call isn't for the swap's chain")


class HexSignatureTest(unittest.TestCase):
    def test_signatures_go_out_as_0x_hex(self):
        sent = []
        client = client_answering([{"executionType": "AUTHORIZE"}, {"status": "nothing"}, {"statusRef": "s"}], sent)
        client.execute({"quoteToken": "qt", "authorization": "hk_1", "signature": "ab" * 65})  # hexbytes 1.x .hex()
        client.recover({"statusRef": "ref", "authorization": "hk_2", "signature": bytes.fromhex("cd" * 65)}, USER)
        client.submit_signature({"quoteToken": "qt", "signature": "ef" * 65, "approvalSignature": bytearray(b"\x12" * 65)})
        self.assertEqual([s["signature"] for s in sent], ["0x" + "ab" * 65, "0x" + "cd" * 65, "0x" + "ef" * 65])
        self.assertEqual(sent[2]["approvalSignature"], "0x" + "12" * 65)


class RecoverStuckFundsTest(unittest.TestCase):
    def test_signs_the_session_then_each_recovery_until_nothing(self):
        sent, steps = [], []
        answers = [
            session(),
            recovering(recovery_typed("RecoverStuckBridgeBalance"), "r-2"),
            done(USDC, "again-1"),
            recovering(recovery_typed("WithdrawStuckUtxos", tokenAddress=OTHER), "r-3"),
            done(OTHER, "again-2"),
            {"status": "nothing"},
        ]
        recovered = recover_stuck_funds(
            client_answering(answers, sent),
            "ref-1",
            USER,
            sign_message=lambda m: steps.append("message") or "0xaa",
            sign_typed_data=lambda t: steps.append(t["primaryType"]) or "0xbb",
            switch_chain=lambda c: steps.append(c),
        )
        self.assertEqual([r["tokenAddress"] for r in recovered], [USDC, OTHER])
        self.assertEqual(steps, ["message", 8453, "RecoverStuckBridgeBalance", 8453, "WithdrawStuckUtxos"])
        self.assertEqual(
            sent,
            [
                {"statusRef": "ref-1"},
                {"statusRef": "ref-1", "authorization": "r-1", "signature": "0xaa"},
                {"statusRef": "ref-1", "authorization": "r-2", "signature": "0xbb"},
                {"statusRef": "ref-1", "authorization": "again-1"},
                {"statusRef": "ref-1", "authorization": "r-3", "signature": "0xbb"},
                {"statusRef": "ref-1", "authorization": "again-2"},
            ],
        )

    def test_refuses_a_tampered_answer_before_signing(self):
        signed = []
        answers = [session(), recovering(recovery_typed("RecoverStuckBridgeBalance", recipient=ATTACKER))]
        with self.assertRaises(UnsafeExecutionError):
            recover_stuck_funds(client_answering(answers, []), "ref-1", USER, signed.append, signed.append)
        self.assertEqual(signed, [SESSION])

    def test_stops_on_a_repeat_and_refuses_done_unasked_or_a_second_session(self):
        again = [session(), recovering(recovery_typed("WithdrawStuckUtxos")), done(USDC, "a-1"), recovering(recovery_typed("WithdrawStuckUtxos"), "r-3")]
        self.assertEqual(len(recover_stuck_funds(client_answering(again, []), "ref-1", USER, lambda m: "0xaa", lambda t: "0xbb")), 1)
        with self.assertRaisesRegex(ValueError, "done without a recovery"):
            recover_stuck_funds(client_answering([session(), done(USDC, "a-1")], []), "ref-1", USER, lambda m: "0xaa", lambda t: "0xbb")
        with self.assertRaisesRegex(ValueError, "session a second time"):
            recover_stuck_funds(client_answering([session(), session("r-9")], []), "ref-1", USER, lambda m: "0xaa", lambda t: "0xbb")
        for stamp in ["2020-01-01T00:00:00.000Z", "2099-01-01T00:00:00"]:  # past; no time zone
            expired = copy.deepcopy(session())
            expired["expiresAt"] = stamp
            asked = []
            with self.assertRaisesRegex(ValueError, "expired"):
                recover_stuck_funds(client_answering([expired], []), "ref-1", USER, asked.append, asked.append)
            self.assertEqual(asked, [])  # refused before the wallet was asked

    def test_a_step_that_expires_while_signing_is_never_sent(self):
        sent = []
        answer = session()
        answer["expiresAt"] = (datetime.now(timezone.utc) + timedelta(milliseconds=200)).isoformat()

        def slow_signer(message):
            time.sleep(0.3)  # the wallet took longer than the step lasts
            return "0xaa"

        with self.assertRaisesRegex(ValueError, "expired"):
            recover_stuck_funds(client_answering([answer], sent), "ref-1", USER, slow_signer, lambda t: "0xbb")
        self.assertEqual(sent, [{"statusRef": "ref-1"}])

    def test_caps_recoveries_at_eight_on_one_chain(self):
        tokens = ["0x" + f"{i:040x}" for i in range(1, 10)]
        answers = [session()]
        for i, token in enumerate(tokens):
            answers += [recovering(recovery_typed("WithdrawStuckUtxos", tokenAddress=token), f"r-{i}"), done(token, f"a-{i}")]
        with self.assertRaisesRegex(ValueError, "more than 8 recoveries"):
            recover_stuck_funds(client_answering(answers, []), "ref-1", USER, lambda m: "0xaa", lambda t: "0xbb")
        on_ethereum = recovery_typed("WithdrawStuckUtxos", chainId=1, tokenAddress=OTHER)
        on_ethereum["domain"]["chainId"] = 1
        two_chains = [session(), recovering(recovery_typed("WithdrawStuckUtxos")), done(USDC, "a-1"), recovering(on_ethereum, "r-3")]
        with self.assertRaisesRegex(ValueError, "on chain 1 after one on chain 8453"):
            recover_stuck_funds(client_answering(two_chains, []), "ref-1", USER, lambda m: "0xaa", lambda t: "0xbb")


if __name__ == "__main__":
    unittest.main()
