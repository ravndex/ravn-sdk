# ravnexchange

Typed Python client for RAVN's public `/api/v1`: quote, execute, submit-signature, status,
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
        "userAddress": "0xYourAddress",
        "destinationAddress": "0xYourAddress",
    })
except RavnApiError as e:
    print(e.code, str(e))
else:
    execution = client.execute({"quoteToken": quote["quoteToken"]})
    # branch on execution["executionType"]: TRANSACTION / SIGNATURE / DEPOSIT
```

Pass `"sandbox": True` on `get_quote` to test the full quote → execute → status flow with no
real funds; see the API's own docs for per-venue exceptions (THORChain BTC-source and
Chainflip can't be sandboxed).

## Status

Published to PyPI via `.github/workflows/publish-python-sdk.yml` using trusted publishing
(OIDC, no stored token), same model as this repo's npm packages, on a push to `main` that
bumps `pyproject.toml`'s version.
