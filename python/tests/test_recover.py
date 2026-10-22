"""check_recovery and recover_stuck_funds, against the same answers as core/src/hinkal.test.ts."""

import copy
import json
import time
import unittest
from datetime import datetime, timedelta, timezone

from ravnexchange import RavnClient, UnsafeExecutionError, check_authorize, check_recovery, recover_stuck_funds

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


class HexSignatureTest(unittest.TestCase):
    def test_signatures_go_out_as_0x_hex(self):
        sent = []
        client = client_answering([{"executionType": "AUTHORIZE"}, {"status": "nothing"}, {"statusRef": "s"}], sent)
        client.execute({"quoteToken": "qt", "authorization": "hk_1", "signature": "ab" * 65})  # hexbytes 1.x .hex()
        client.recover({"statusRef": "ref", "authorization": "hk_2", "signature": bytes.fromhex("cd" * 65)}, USER)
        client.submit_signature({"quoteToken": "qt", "signature": "0x" + "ef" * 65})
        self.assertEqual([s["signature"] for s in sent], ["0x" + "ab" * 65, "0x" + "cd" * 65, "0x" + "ef" * 65])


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
