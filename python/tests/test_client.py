"""Stdlib unittest, no pytest dependency: mirrors sdk/core/src/client.test.ts's approach of
injecting a fake transport instead of hitting the network."""

import io
import json
import unittest
import urllib.error

from ravnexchange import RavnApiError, RavnClient


class FakeResponse:
    def __init__(self, body: dict, status: int = 200):
        self.status = status
        self._body = json.dumps(body).encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None


def fake_urlopen_returning(body: dict, status: int = 200):
    def _urlopen(req):
        if status >= 400:
            raise urllib.error.HTTPError(
                req.full_url, status, "error", None, io.BytesIO(json.dumps(body).encode("utf-8"))
            )
        return FakeResponse(body, status)

    return _urlopen


class RavnClientTest(unittest.TestCase):
    def test_get_quote_returns_unwrapped_data(self):
        client = RavnClient(
            api_key="rvn_test",
            urlopen=fake_urlopen_returning({"data": {"quoteToken": "abc", "executable": True}}),
        )
        result = client.get_quote(
            {
                "inputChainId": 1,
                "outputChainId": 1,
                "inputToken": "0xEeee",
                "outputToken": "0xA0b8",
                "inputAmount": "1000000000000000000",
                "userAddress": "0xabc",
                "sandbox": True,
            }
        )
        self.assertEqual(result, {"quoteToken": "abc", "executable": True})

    def test_error_envelope_raises_ravn_api_error(self):
        client = RavnClient(
            urlopen=fake_urlopen_returning(
                {"error": {"code": "NO_LIQUIDITY", "message": "No liquidity"}}, status=422
            )
        )
        with self.assertRaises(RavnApiError) as ctx:
            client.get_quote({})
        self.assertEqual(ctx.exception.code, "NO_LIQUIDITY")

    def test_non_json_body_raises_internal_error(self):
        def _urlopen(req):
            raise urllib.error.HTTPError(req.full_url, 502, "bad gateway", None, io.BytesIO(b"<html>"))

        client = RavnClient(urlopen=_urlopen)
        with self.assertRaises(RavnApiError) as ctx:
            client.get_status("tok", "ref")
        self.assertEqual(ctx.exception.code, "INTERNAL")

    def test_get_status_posts_json_body(self):
        seen = {}

        def _urlopen(req):
            seen["url"], seen["method"], seen["body"] = req.full_url, req.get_method(), req.data
            return FakeResponse({"data": {"status": "success", "venue": "relay"}})

        RavnClient(urlopen=_urlopen).get_status("tok", "0xref")
        self.assertEqual(seen["url"], "https://app.ravn.exchange/api/v1/status")
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(json.loads(seen["body"]), {"quoteToken": "tok", "ref": "0xref"})
        RavnClient(urlopen=_urlopen).get_status("tok", "order-id", tx_hash="0xfee")
        self.assertEqual(json.loads(seen["body"]), {"quoteToken": "tok", "ref": "order-id", "txHash": "0xfee"})

    def test_submit_transaction_posts_signed_transaction(self):
        seen = {}

        def _urlopen(req):
            seen["url"], seen["method"], seen["body"] = req.full_url, req.get_method(), req.data
            return FakeResponse({"data": {"txHash": "5igSig"}})

        result = RavnClient(urlopen=_urlopen).submit_transaction(
            {"quoteToken": "qt-exec", "signedTransaction": "AQID"}
        )
        self.assertEqual(result, {"txHash": "5igSig"})
        self.assertEqual(seen["url"], "https://app.ravn.exchange/api/v1/submit-transaction")
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(json.loads(seen["body"]), {"quoteToken": "qt-exec", "signedTransaction": "AQID"})

    def test_execute_sends_idempotency_key_as_header_only(self):
        seen = {}

        def _urlopen(req):
            seen["body"], seen["key"] = json.loads(req.data), req.get_header("Idempotency-key")
            return FakeResponse({"data": {"executionType": "DEPOSIT", "quoteToken": "qt"}})

        client = RavnClient(urlopen=_urlopen)
        params = {"quoteToken": "qt", "idempotencyKey": "4f1c-ab_9"}
        client.execute(params)
        self.assertEqual(seen, {"body": {"quoteToken": "qt"}, "key": "4f1c-ab_9"})
        # The caller's dict is left as it was: the same params can be sent again with the same key.
        self.assertEqual(params, {"quoteToken": "qt", "idempotencyKey": "4f1c-ab_9"})
        client.execute({"quoteToken": "qt"})
        self.assertEqual(seen, {"body": {"quoteToken": "qt"}, "key": None})

    def test_execute_refuses_a_key_the_api_would_before_sending(self):
        def _urlopen(req):
            raise AssertionError("nothing may be sent")

        client = RavnClient(urlopen=_urlopen)
        for key in ["", "has space", "x" * 256, "caf\u00e9", "line\nbreak", 123]:
            with self.assertRaises(RavnApiError) as ctx:
                client.execute({"quoteToken": "qt", "idempotencyKey": key})
            self.assertEqual(ctx.exception.code, "INVALID_REQUEST")

    def test_get_chains_returns_list(self):
        client = RavnClient(urlopen=fake_urlopen_returning({"data": [{"chainId": 1}]}))
        self.assertEqual(client.get_chains(), [{"chainId": 1}])


if __name__ == "__main__":
    unittest.main()
