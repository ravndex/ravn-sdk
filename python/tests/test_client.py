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

    def test_get_chains_returns_list(self):
        client = RavnClient(urlopen=fake_urlopen_returning({"data": [{"chainId": 1}]}))
        self.assertEqual(client.get_chains(), [{"chainId": 1}])


if __name__ == "__main__":
    unittest.main()
