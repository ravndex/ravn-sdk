# Runnable as-is: `pip install ravnexchange && python quote_and_execute.py`
#
# Same shape as quote-and-execute.mjs: the read-only half of the API needs no wallet and no
# API key. Executing needs a real signer, which this package deliberately doesn't provide.

from ravnexchange import RavnClient, RavnApiError

client = RavnClient()  # omit api_key for the anonymous tier

chains = client.get_chains()
print(f"RAVN lists tokens on {len(chains)} chains, e.g. {chains[0]['name']}")

try:
    quote = client.get_quote(
        {
            "inputChainId": 1,  # Ethereum
            "outputChainId": 8453,  # Base
            "inputToken": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",  # native ETH
            "outputToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  # Base USDC
            "inputAmount": "1000000000000000000",  # 1 ETH, in wei
            # A placeholder that isn't a real 0x address (even one you don't own) fails as
            # NO_LIQUIDITY, not a clear validation error -- replace this with your own address
            # before executing for real.
            "userAddress": "0x000000000000000000000000000000000000dEaD",
            # Omitting destinationAddress/refundAddress makes this a preview-only quote
            # (executable is False) -- fine for just showing a price, not enough to execute.
        }
    )
except RavnApiError as e:
    print(f"{e.code}: {e}")
else:
    print(
        f"Quote: {quote['input']['amount']} {quote['input']['token']['symbol']} -> "
        f"{quote['output']['amount']} {quote['output']['token']['symbol']} via {quote['venue']['name']}, "
        f"executable={quote['executable']}"
    )
    if quote["executable"]:
        # Real usage: execution = client.execute({"quoteToken": quote["quoteToken"]})
        # then branch on execution["executionType"] and hand it to your own signer.
        print("Ready to execute; call client.execute({'quoteToken': quote['quoteToken']}) next.")
