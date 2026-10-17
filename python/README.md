# ravnexchange

Typed Python client for RAVN's public `/api/v1`: quote, execute, submit-signature, submit-transaction, status,
tokens, chains. Zero runtime dependencies (built on `urllib.request`, not `requests`).

Same scope as the official TS client (`@ravnexchange/sdk`); for an agent that already speaks
MCP, RAVN's MCP server (see the root [README](https://github.com/ravndex/ravn-sdk)) covers this
and more; this package is for a plain, non-agent Python backend that wants a typed wrapper
instead of hand-rolling HTTP calls against the JSON API.

## Install

```bash
pip install ravnexchange
```

## Usage

```python
from ravnexchange import RavnClient, RavnApiError

client = RavnClient(api_key="rvn_live_...")  # omit for the anonymous tier

try:
    quote = client.get_quote({
        "inputChainId": 1,
        "outputChainId": 8453,
        "inputToken": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        "outputToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "inputAmount": "1000000000000000000",
        # Must be a real 0x-prefixed 40-hex-char address: a malformed one fails as NO_LIQUIDITY,
        # not a clear validation error.
        "userAddress": "0xYourWalletAddress",
        "destinationAddress": "0xYourWalletAddress",
    })
except RavnApiError as e:
    print(e.code, str(e))
else:
    execution = client.execute({"quoteToken": quote["quoteToken"]})
    # branch on execution["executionType"]: TRANSACTION / SIGNATURE / DEPOSIT
```

Pass `"sandbox": True` on `get_quote` to test the full quote → execute → status flow with no
real funds; see the API's own docs for per-venue exceptions (THORChain BTC-source,
Chainflip, and Houdini Swap can't be sandboxed).

## Parity with `@ravnexchange/sdk` 0.2.0

Same calls and the same wire shapes: responses are plain dicts, so new API fields such as an
execution's `sandbox` and `approval.reset` pass through as they are. What the TS client has and this
one doesn't yet:

- **No `execute_and_track`.** You sequence approval, swap, RAVN's fee and status polling yourself.
  Do it the way the TS helper does: wait for the approval's receipt before the swap; send
  `approval.reset` (when present) and wait for it before the approval; never send anything from an
  execution with `sandbox: True`; send `fee["transaction"]` only once the swap's own receipt says
  success; pass its hash as `tx_hash` on every `get_status` poll; keep polling past `expired`
  (a refund is due), about once a minute, until `refunded`.
- **No retries.** Retry a status poll yourself on `RATE_LIMITED`, a 5xx (`INTERNAL`,
  `BUILD_FAILED`, `VENUE_RATE_LIMITED`) or a network error, waiting `e.details["retryAfterSec"]`
  when it's set. Never re-submit a signature after `BUILD_FAILED`: the order may be placed.
- **`RavnApiError` has no `status` or `retry_after_sec`.** Read `e.code` and
  `e.details.get("retryAfterSec")`.
- **A network failure raises `urllib.error.URLError`**, not a `RavnApiError` (the TS client wraps it
  as `NETWORK_ERROR`).

## Status

Published to PyPI via `.github/workflows/publish-python-sdk.yml` using trusted publishing
(OIDC, no stored token), same model as this repo's npm packages, on a push to `main` that
bumps `pyproject.toml`'s version.
