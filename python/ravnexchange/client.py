"""Typed client for RAVN's public /api/v1 surface.

Deliberately a standalone mirror of @ravnexchange/sdk's RavnClient
(sdk/core/src/client.ts) — same scope (quote, execute, submit-signature, status, tokens,
chains), same envelope-unwrapping/error-throwing behavior, snake_cased. Keep the two in sync
by hand when the API's public contract changes; ships to PyPI on its own and can't import
from the TS package or the app's internal source tree.

Zero runtime dependencies — built on urllib.request, not requests, so installing this adds
nothing to a project's dependency tree.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional, TypedDict

# ravn.exchange is the marketing site (separate deployment, no /api/* routes at all) — the
# actual app, including this API, is served from the app subdomain.
DEFAULT_BASE_URL = "https://app.ravn.exchange/api/v1"


class RavnApiError(Exception):
    """Raised for every non-2xx response, or a 2xx body that still carries an `error` field."""

    def __init__(
        self,
        code: str,
        message: str,
        details: Any = None,
        meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details
        self.meta = meta


class GetQuoteParams(TypedDict, total=False):
    inputChainId: int
    outputChainId: int
    inputToken: str
    outputToken: str
    inputAmount: str
    userAddress: str
    destinationAddress: str
    refundAddress: str
    slippageBps: int
    rankingMode: str
    excludeVenues: List[str]
    sandbox: bool


class ExecuteParams(TypedDict, total=False):
    quoteToken: str
    destinationAddress: str
    refundAddress: str


class SubmitSignatureParams(TypedDict, total=False):
    quoteToken: str
    signature: str
    approvalSignature: str


# Injectable transport, mirroring RavnClientConfig.fetch in the TS client — lets tests (and
# unusual runtimes) supply their own opener instead of hitting the network.
UrlOpener = Callable[[urllib.request.Request], Any]


class RavnClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        urlopen: UrlOpener = urllib.request.urlopen,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._urlopen = urlopen

    def _request(self, path: str, method: str = "GET", body: Optional[Dict[str, Any]] = None) -> Any:
        headers = {"content-type": "application/json"}
        if self._api_key:
            headers["x-api-key"] = self._api_key
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            f"{self._base_url}{path}", data=data, headers=headers, method=method
        )

        try:
            with self._urlopen(req) as res:
                status = res.status
                raw = res.read()
        except urllib.error.HTTPError as e:
            # A non-2xx still carries a JSON error envelope for this API — read it the same
            # way a successful response would be, rather than letting HTTPError propagate.
            status = e.code
            raw = e.read()

        try:
            envelope = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            # A non-JSON body (an intermediary's HTML error page, an empty response) must
            # still surface as the one error type this client promises.
            raise RavnApiError("INTERNAL", f"HTTP {status}: response was not valid JSON") from None

        error = envelope.get("error")
        if status >= 400 or error:
            err = error or {"code": "INTERNAL", "message": f"HTTP {status}"}
            raise RavnApiError(
                err.get("code", "INTERNAL"),
                err.get("message", "Unknown error"),
                err.get("details"),
                envelope.get("meta"),
            )

        return envelope.get("data")

    def get_quote(self, params: GetQuoteParams) -> Dict[str, Any]:
        """POST /v1/quote — omitting destinationAddress/refundAddress returns a preview-only
        quote (see the response's `executable` field)."""
        return self._request("/quote", "POST", dict(params))

    def execute(self, params: ExecuteParams) -> Dict[str, Any]:
        """POST /v1/execute — branch on the returned executionType (TRANSACTION / SIGNATURE / DEPOSIT)."""
        return self._request("/execute", "POST", dict(params))

    def submit_signature(self, params: SubmitSignatureParams) -> Dict[str, Any]:
        """POST /v1/submit-signature — SIGNATURE-type executions only. Returns {"statusRef": ...}
        to poll get_status with."""
        return self._request("/submit-signature", "POST", dict(params))

    def get_status(self, quote_token: str, ref: str) -> Dict[str, Any]:
        """GET /v1/status — ref is the DEPOSIT address or the statusRef from submit_signature."""
        qs = urllib.parse.urlencode({"quoteToken": quote_token, "ref": ref})
        return self._request(f"/status?{qs}")

    def get_tokens(self, chain_id: int) -> List[Dict[str, Any]]:
        """GET /v1/tokens — RAVN's listed token registry for one chain. Not a per-pair
        routability guarantee."""
        qs = urllib.parse.urlencode({"chainId": chain_id})
        return self._request(f"/tokens?{qs}")

    def get_chains(self) -> List[Dict[str, Any]]:
        """GET /v1/chains — every chain RAVN lists tokens for. Static; safe to cache client-side."""
        return self._request("/chains")
