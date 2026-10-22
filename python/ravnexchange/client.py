"""Typed client for RAVN's public /api/v1 surface.

Deliberately a standalone mirror of @ravnexchange/sdk's RavnClient
(sdk/core/src/client.ts): same scope (quote, execute, submit-signature, submit-transaction, status,
recover, tokens, chains), same envelope-unwrapping/error-throwing behavior, snake_cased. Keep the two in sync
by hand when the API's public contract changes; ships to PyPI on its own and can't import
from the TS package or the app's internal source tree.

Zero runtime dependencies: built on urllib.request, not requests, so installing this adds
nothing to a project's dependency tree.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional, TypedDict

from .recover import check_recovery

# ravn.exchange is the marketing site (separate deployment, no /api/* routes at all); the
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
    slippageBps: int  # omitted = Auto; setting it keeps no-minimum venues (Rift) out unless allowNoMinimum
    # Let venues with no minimum (today Rift) race beside slippageBps. Their quotes carry
    # slippage.noMinimum True and guaranteedMin None: slippageBps does not protect them.
    allowNoMinimum: bool
    rankingMode: str
    # Venues never to use, also kept out of the steps of RAVN's multi-step routes.
    excludeVenues: List[str]
    # Race only these venues, e.g. ["bebop"] for RFQ only; excludeVenues still applies on top.
    # It covers every venue RAVN routes funds through: a multi-step route needs its venue.id and
    # every venue in its hops listed, e.g. ["compose", "jupiter", "relay"]; the stablecoin route
    # also needs "0x_swap". Venues that swap for you may route on their own (see the API's /quote
    # docs). An empty list is rejected.
    onlyVenues: List[str]
    # Private swap: NEAR Intents, Houdini Swap, and Hinkal with authorizeSteps. See the API's /quote
    # docs for Houdini's compliance rules (it is sent the request's IP, user-agent and clientTimezone).
    confidential: bool
    # Your execute flow answers AUTHORIZE steps (Hinkal: the paying wallet signs twice, each answer
    # an execute of its own). Without it (or onlyVenues naming "hinkal") a private race leaves
    # Hinkal out. Never sent on its own.
    authorizeSteps: bool
    clientTimezone: str  # end user's IANA timezone, forwarded only to Houdini; default UTC
    quoteSessionId: str  # analytics only: same value while re-pricing one swap, max 64 chars
    sandbox: bool
    # You post signed Solana transactions back (submit_transaction) instead of broadcasting them:
    # adds Layerswap's memo routes. A TRANSACTION execution carrying `submit` must go that way.
    broadcastViaRavn: bool


class ExecuteParams(TypedDict, total=False):
    quoteToken: str
    destinationAddress: str
    refundAddress: str
    clientTimezone: str
    # Only after an AUTHORIZE answer: its authorization, with the paying wallet's signature over its
    # `sign`. Both or neither.
    authorization: str
    signature: str


class RecoverParams(TypedDict, total=False):
    statusRef: str  # the Hinkal swap's TRANSACTION statusRef (its order id)
    authorization: str
    signature: str


class SubmitSignatureParams(TypedDict, total=False):
    quoteToken: str
    signature: str
    approvalSignature: str


class SubmitTransactionParams(TypedDict, total=False):
    quoteToken: str  # the one execute returned with that transaction
    signedTransaction: str  # transaction.serialized after the user's wallet signed it, base64


# Injectable transport, mirroring RavnClientConfig.fetch in the TS client: lets tests (and
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
            # A non-2xx still carries a JSON error envelope for this API; read it the same
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
        """POST /v1/quote: omitting destinationAddress/refundAddress returns a preview-only
        quote (see the response's `executable` field)."""
        return self._request("/quote", "POST", dict(params))

    def execute(self, params: ExecuteParams) -> Dict[str, Any]:
        """POST /v1/execute: branch on the returned executionType (TRANSACTION / SIGNATURE / DEPOSIT;
        AUTHORIZE only on an authorizeSteps quote: sign `sign` with the paying wallet and execute
        again with the same quoteToken, authorization and signature, until a TRANSACTION comes back)."""
        return self._request("/execute", "POST", dict(params))

    def recover(self, params: RecoverParams, user_address: str) -> Dict[str, Any]:
        """POST /v1/recover: one step of getting back what a failed Hinkal swap left at Hinkal.
        `user_address` is the wallet that paid, from your own wallet connection: the answer is
        checked to send funds back to it alone (check_recovery) before you can sign it.
        recover_stuck_funds runs the whole flow."""
        answer = self._request("/recover", "POST", dict(params))
        check_recovery(answer, user_address)
        return answer

    def submit_signature(self, params: SubmitSignatureParams) -> Dict[str, Any]:
        """POST /v1/submit-signature: SIGNATURE-type executions only. Pass the quoteToken execute
        returned, not the quote's own (compose refuses it). Returns {"statusRef": ...} to poll
        get_status with."""
        return self._request("/submit-signature", "POST", dict(params))

    def submit_transaction(self, params: SubmitTransactionParams) -> Dict[str, Any]:
        """POST /v1/submit-transaction: only for a TRANSACTION execution carrying `submit`
        (broadcastViaRavn quotes). RAVN checks the signed transaction, then sends it; refused,
        nothing is sent. Returns {"txHash": ...}; poll get_status with the execution's statusRef."""
        return self._request("/submit-transaction", "POST", dict(params))

    def get_status(self, quote_token: str, ref: str, tx_hash: Optional[str] = None) -> Dict[str, Any]:
        """POST /v1/status: pass the quoteToken execute returned (not the quote's own), and as ref
        the execution's statusRef, submit_signature's statusRef, or the origin tx hash. POST, not
        GET: a 2-hop quoteToken in a query string can exceed header limits and fail with 431.
        tx_hash: a two-hop route's hop-1 transaction, or the fee payment a DEPOSIT's
        fee.transaction asked for; it's how RAVN proves the fee your share is paid from."""
        body = {"quoteToken": quote_token, "ref": ref}
        if tx_hash:
            body["txHash"] = tx_hash
        return self._request("/status", "POST", body)

    def get_tokens(self, chain_id: int) -> List[Dict[str, Any]]:
        """GET /v1/tokens: RAVN's listed token registry for one chain. Not a per-pair
        routability guarantee."""
        qs = urllib.parse.urlencode({"chainId": chain_id})
        return self._request(f"/tokens?{qs}")

    def get_chains(self) -> List[Dict[str, Any]]:
        """GET /v1/chains: every chain RAVN lists tokens for. Static; safe to cache client-side."""
        return self._request("/chains")
