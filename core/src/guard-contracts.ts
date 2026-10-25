/**
 * The contracts RAVN's venues use, per chain: the only transaction targets and spenders the guard
 * (./guard.ts) lets through. Built 2026-10-21 from every transaction and approval RAVN's /v1/execute
 * returned across its chains and venues, and from each venue's own API or SDK for what that sweep
 * couldn't reach (KyberSwap's /routes, OKX's /swap, Across's /chains, Garden's /assets, THORChain's
 * inbound addresses, Mayan's SDK). A venue that moves to a new contract is refused until this list
 * knows it: RAVN's server runs this same check on what it hands out and alerts on a refusal, and
 * GuardOptions.allowContracts covers the gap meanwhile. Arc (5042) added 2026-10-21 from the same kind of
 * sweep: 33 builds across Relay, Across, Eco, 0x Swap/Gasless, KyberSwap, Fly and OKX, plus Garden's /assets.
 * Route's RouteEntry (Robinhood) added 2026-10-25 from Route's own builds.
 */

const ETHEREUM = 1;
const OPTIMISM = 10;
const BNB = 56;
const UNICHAIN = 130;
const POLYGON = 137;
const MONAD = 143;
const ZKSYNC = 324;
const WORLD_CHAIN = 480;
const HYPEREVM = 999;
const TEMPO = 4217;
const ARC = 5042;
const ROBINHOOD = 4663;
const BASE = 8453;
const ARBITRUM = 42161;
const AVALANCHE = 43114;
const LINEA = 59144;

const ALL = [ETHEREUM, OPTIMISM, BNB, UNICHAIN, POLYGON, MONAD, ZKSYNC, WORLD_CHAIN, HYPEREVM, TEMPO, ARC, ROBINHOOD, BASE, ARBITRUM, AVALANCHE, LINEA];
// zkSync derives contract addresses differently, so a venue's one-address-everywhere contract isn't there.
const NOT_ZKSYNC = ALL.filter((c) => c !== ZKSYNC);

const PERMIT2_CANONICAL = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const COW_CHAINS = [ETHEREUM, ARBITRUM, BASE, POLYGON, LINEA, AVALANCHE, BNB];
const COW_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";

/** Permit2, per chain (zkSync's is its own deployment). */
export const PERMIT2: Record<number, string> = {
  ...Object.fromEntries(NOT_ZKSYNC.map((c) => [c, PERMIT2_CANONICAL])),
  [ZKSYNC]: "0x0000000000225e31D15943971F47aD3022F714Fa",
};

/** CoW Protocol's settlement contract: the verifyingContract of the orders it asks users to sign. */
export const COW_SETTLEMENT: Record<number, string> = Object.fromEntries(COW_CHAINS.map((c) => [c, "0x9008D19f58AAbD9eD0D60971565AA8510560ab41"]));

/**
 * Spenders that move a token only against the user's own signature for each transfer (Permit2, CoW's
 * vault relayer), so an approval to them beyond the swap's amount grants nothing by itself. The
 * signatures are what the guard bounds.
 */
export function signatureGatedSpenders(chainId: number): Set<string> {
  return new Set([PERMIT2[chainId], COW_CHAINS.includes(chainId) ? COW_VAULT_RELAYER : undefined].filter((a): a is string => !!a).map((a) => a.toLowerCase()));
}

/** WETH that mints to another address in one call (depositTo): RAVN's coin fee on these chains. */
export const WETH_FEE_MINTERS: Record<number, string> = {
  [ROBINHOOD]: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  [ARBITRUM]: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};

/** Hinkal.sol, the same address on every chain Hinkal runs on (its GET /contract-addresses, 2026-10-21):
 * a private swap's deposit. Known only to a TRANSACTION, as its target and approval spender, and then
 * only calling prooflessDeposit: not in KNOWN_CONTRACTS, which signatures may also name. */
export const HINKAL = "0x7cb60446d7635C68EDf1c568cac74A1f98c1Cfa4";
export const HINKAL_CHAINS: readonly number[] = [ETHEREUM, BASE, ARBITRUM, POLYGON, BNB, ROBINHOOD];

/** Where RAVN's own fee is paid, per ecosystem. */
export const RAVN_FEE_WALLETS = {
  evm: "0x12d2425fD88c693EDB4dE004E0c747879B7D6933",
  solana: "4pQtttNDe8kdQjhJ22LA2Tqnen9smPjoJj7HM3X8ZNYf",
  bitcoin: "bc1qe8px5j4l6sexjzgs7a4khwt9tmhrzfgf3nuzsa",
};

// [chains, addresses, venue]: each address is accepted as a transaction target and a spender on those
// chains. Permit2 and CoW's vault relayer are spenders only (signatureGatedSpenders): a transaction to
// Permit2 could grant an allowance to anyone.
const ENTRIES: [readonly number[], readonly string[], string][] = [
  [NOT_ZKSYNC, ["0x0000000000001fF3684f28c67538d4D072C22734"], "0x AllowanceHolder"],
  [[ROBINHOOD, ETHEREUM, ARBITRUM, BASE, OPTIMISM, POLYGON, BNB, AVALANCHE, LINEA, UNICHAIN, HYPEREVM, MONAD, ARC], ["0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"], "KyberSwap"],
  [[ETHEREUM, POLYGON, ARBITRUM, BASE, BNB, OPTIMISM, ROBINHOOD], ["0xBeb0009ACa35087ce7cCF11637E24dd1Aad3bf2A", "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F"], "Bebop"],
  [
    ALL.filter((c) => c !== LINEA),
    ["0x4cd00e387622c35bddb9b4c962c136462338bc31", "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be", "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"],
    "Relay",
  ],
  [[LINEA], ["0x59916da825d2d2ec1bf878d71c88826f6633ecca", "0x8754bc615047de01228a7527b712806a71a8dc9a", "0x9ef6d3c2f60d7b9008d74cab1fc0f899c957c819"], "Relay (Linea)"],
  [NOT_ZKSYNC.filter((c) => c !== ARC), ["0x97CCDBea4632140639aD5eA9b944aa034eb15fD4"], "Across periphery"],
  // Arc's is its own deployment: no code at 0x97CC… there; Across's Arc swap routes go through this one.
  [[ARC], ["0xE791A2669bef779Ff7A4A9CF789F8Ee2CA20a32c"], "Across periphery (Arc)"],
  [[ZKSYNC], ["0x7c99ced6d8011af8a52488884f7ba2c61b0fa57d"], "Across periphery (zkSync)"],
  // Not on Arc: no code there and Mayan doesn't serve it (a plain CREATE address its deployer could still fill).
  [NOT_ZKSYNC.filter((c) => c !== ARC), ["0x337685fdaB40D39bd02028545a4FfA7D287cC3E2"], "Mayan forwarder"],
  [NOT_ZKSYNC, ["0xEC000769a73b70e16f361a442292500b3BCf4A85"], "Eco portal"],
  [ALL, ["0xe226e4825cb215abafad98fdd400583eab6a594f"], "Layerswap depository"],
  [NOT_ZKSYNC, ["0x20f6ee51340adeed01a59b0e65cb3703f3dc860c"], "Fly Trade"],
  [[ZKSYNC], ["0xc5b20203b6807e742853c96ce7dcfb1e7b201c0a"], "Fly Trade (zkSync)"],
  // RouteEntry (route.fun, 2026-10-25): verified on Sourcify; every Route build calls it and approves it.
  [[ROBINHOOD], ["0x15dBb64b42EABe52A6ddc377e966F408756815BE"], "Route"],
];

// Across's SpokePool, per chain (GET app.across.to/api/chains).
const ACROSS_SPOKE_POOL: Record<number, string> = {
  [ETHEREUM]: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
  [OPTIMISM]: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
  [BNB]: "0x4e8E101924eDE233C13e2D8622DC8aED2872d505",
  [UNICHAIN]: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  [POLYGON]: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096",
  [MONAD]: "0xd2ecb3afe598b746F8123CaE365a598DA831A449",
  [ZKSYNC]: "0xE0B015E54d54fc84a6cB9B666099c46adE9335FF",
  [WORLD_CHAIN]: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  [HYPEREVM]: "0x35E63eA3eb0fb7A3bc543C71FB66412e1F6B0E04",
  [TEMPO]: "0x2d4710F04Da90184255782d3715224A6C776955D",
  [ARC]: "0x9b4A302A548c7e313c2b74C461db7b84d3074A84",
  [ROBINHOOD]: "0xD29C85F15DF544bA632C9E25829fd29d767d7978",
  [BASE]: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  [ARBITRUM]: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
  [AVALANCHE]: "0xFE9D541c92E4e90437C7152A00244886dE37a658",
  [LINEA]: "0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75",
};

// Nordstern's guard contract, per chain (as RAVN's adapter pins it).
const NORDSTERN: Record<number, string> = {
  [ROBINHOOD]: "0x603206D6105217DD972E4Ab30676A220CA393346",
  [ETHEREUM]: "0xa929c559E5e6537359680F39CB4E3708E1a14dd1",
  [ARBITRUM]: "0x57f96440f1b1cAD53B40A8924BD540b1279A491c",
  [BASE]: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
  [OPTIMISM]: "0xa575f37e869e6887564F87c07e2885e08D542C4a",
  [POLYGON]: "0x99bA7d569EA69671B399A7cC488b687515F7EC23",
  [BNB]: "0x1a3304cBef66de00FbE1548CC4C6585aD22FbCFf",
  [AVALANCHE]: "0xa575f37e869e6887564F87c07e2885e08D542C4a",
  [LINEA]: "0x2fF506ed9729580EF8Bf04429614beB1baE5F76D",
  [UNICHAIN]: "0x3FFc2315A992b01dc4B3f79C8EEa1921091Ee24f",
  [WORLD_CHAIN]: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
  [HYPEREVM]: "0x2fF506ed9729580EF8Bf04429614beB1baE5F76D",
  [MONAD]: "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d",
};

// OKX's DEX router (tx.to) and token-approval contract, per chain (OKX's /swap, 2026-10-21).
const OKX: Record<number, [string, string]> = {
  [ETHEREUM]: ["0x8feab81d36e7576107d5de0758c1b839be31b4f6", "0x40aA958dd87FC8305b97f2BA922CDdCa374bcD7f"],
  [OPTIMISM]: ["0x1f5b43127414e36c31ecb5ff5567262997cd24d0", "0x68D6B739D2020067D1e2F713b999dA97E4d54812"],
  [BNB]: ["0x5994814f2c4040b863a0125a45de152a8c2a4dec", "0x2c34A2Fb1d0b4f55de51E1d0bDEfaDDce6b7cDD6"],
  [UNICHAIN]: ["0xe3dab8bf5187f9b4e8e89ff5414d7cf71e2c82e1", "0x2e28281Cf3D58f475cebE27bec4B8a23dFC7782c"],
  [POLYGON]: ["0x3c4829196bfadff4394726b45159aeaac6fcd41c", "0x3B86917369B83a6892f553609F3c2F439C184e31"],
  [MONAD]: ["0xc1c76e784db8d68585fb608ce68fc5dcff14000e", "0xf534A8a1CAD0543Cd6438f7534CA3486c01998d4"],
  [ZKSYNC]: ["0x46eDEcEa0228f04Ab88dC34BE98314863bA40bE0", "0xc67879F4065d3B9fe1C09EE990B891Aa8E3a4c2f"],
  [HYPEREVM]: ["0xb193874f0c77948d2bcfec2efaf8bc65b4c2ca89", "0x56e6983D59bF472Ced0E63966A14d94A3A291589"],
  [ARC]: ["0x4E3bcCE28cAf98A143Fd8BD9e4875ccAb3E7bBE0", "0x2B9899bC46Bf0eE094225995f4bD496d42f261Af"],
  [ROBINHOOD]: ["0x6e2a35a7ad683cf634d91492d73bb7ff774c6919", "0x42170295F1173c9e5874ea9d00c6d137E1a4f53d"],
  [BASE]: ["0x67d03631fe51b741c0c00c4e16eb662ac84381df", "0x57df6092665eb6058DE53939612413ff4B09114E"],
  [ARBITRUM]: ["0x09f94b5fc68e227c323a6fbae3bd98c97fd8c849", "0x70cBb871E8f30Fc8Ce23609E9E0Ea87B6b222F58"],
  [AVALANCHE]: ["0xab96dcfa7a7d669d9bf5918fab8641479973dd0a", "0x40aA958dd87FC8305b97f2BA922CDdCa374bcD7f"],
  [LINEA]: ["0xdfcb0cecc10e78f3f3749f3f3d3ee4047b2c9829", "0x57df6092665eb6058DE53939612413ff4B09114E"],
};

// THORChain's router, per chain (inbound_addresses). The vault it pays is in the calldata.
const THORCHAIN_ROUTER: Record<number, string> = {
  [ETHEREUM]: "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146",
  [BNB]: "0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b",
  [BASE]: "0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4",
  [AVALANCHE]: "0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4",
};

// Garden's swap (HTLC) contracts, per chain and asset (GET /v2/assets).
const GARDEN: Record<number, string[]> = {
  [ETHEREUM]: ["0xe35d025d0f0d9492db4700FE8646f7F89150eC04", "0x5fA58e4E89c85B8d678Ade970bD6afD4311aF17E", "0xCF5E5e28848cFe779f7Fb711C57857Cb3b144A19", "0xD781a2abB3FCB9fC0D1Dd85697c237d06b75fe95"],
  [ARBITRUM]: ["0xb5AE9785349186069C48794a763DB39EC756B1cF"],
  [BASE]: ["0xe35d025d0f0d9492db4700FE8646f7F89150eC04", "0x7aE2D05e6fD9F12A9D4bA5C61384F4D0b90843eb", "0x227A436e93AAEf856ed406713F2bc3D110A7b797"],
  [BNB]: ["0xe74784E5A45528fDEcB257477DD6bd31c8ef0761"],
  [HYPEREVM]: ["0xDC74a45e86DEdf1fF7c6dac77e0c2F082f9E4F72"],
  [ROBINHOOD]: ["0x147bf8d6Fa3392D2376ef5F6738F3D2931BdDb49", "0xd8BF1D34AE05B6F631dE898aE9F8f91e08661B59"],
  [TEMPO]: ["0x0289b0da24962121b95400b572d08dbc01bb1281", "0x5fa58e4e89c85b8d678ade970bd6afd4311af17e"],
  [ARC]: ["0x5fA58e4E89c85B8d678Ade970bD6afD4311aF17E", "0x89b6612A2121BFBd1c2Dc593504AbE4e5d5E9296"],
};

/** The contract approved to swap through `router`, where it's a different one (OKX's approval contract). */
export function separateSpender(chainId: number, router: string): string | undefined {
  const pair = OKX[chainId];
  return pair && pair[0].toLowerCase() === router.toLowerCase() ? pair[1].toLowerCase() : undefined;
}

function build(): Record<number, readonly string[]> {
  const out: Record<number, Set<string>> = Object.fromEntries(ALL.map((c) => [c, new Set<string>()]));
  const add = (c: number, ...addresses: string[]) => addresses.forEach((a) => out[c]?.add(a.toLowerCase()));
  for (const [chains, addresses] of ENTRIES) for (const c of chains) add(c, ...addresses);
  for (const [c, a] of Object.entries(ACROSS_SPOKE_POOL)) add(Number(c), a);
  for (const [c, a] of Object.entries(NORDSTERN)) add(Number(c), a);
  for (const [c, pair] of Object.entries(OKX)) add(Number(c), ...pair);
  for (const [c, a] of Object.entries(THORCHAIN_ROUTER)) add(Number(c), a);
  for (const [c, list] of Object.entries(GARDEN)) add(Number(c), ...list);
  return Object.fromEntries(Object.entries(out).map(([c, s]) => [c, [...s]]));
}

/** Lowercase venue contracts per EVM chain id. A chain absent here is refused outright. */
export const KNOWN_CONTRACTS: Record<number, readonly string[]> = build();

/**
 * Solana programs RAVN's venues call: Jupiter (its aggregator and RFQ order engine), OKX, 0x, Relay,
 * Mayan (from its SDK, with the Titan and DFlow routers it swaps through), Wormhole/CCTP under
 * Mayan, and Garden. System, token, associated-account, compute-budget and memo programs are read, not listed.
 */
export const SOLANA_PROGRAMS: ReadonlySet<string> = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH",
  "proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u",
  "Sett1erwx2eqT5A8uvu8GBxDFT2W5TNnhirL7hLmb8m",
  "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2",
  "BLZRi6frs4X4DNLw56V4EXai1b6QVESN1BhHBTYM9VcY",
  "dkpZqrxHFrhziEMQ931GLtfy11nFkCsfMftH9u6QwBU",
  "Gx9rivpS3YR8pBFwMuP6omYqVxunpLvLkNn7ubNyuZZ5",
  "FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf",
  "D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa",
  "5VtQHnhs2pfVEr68qQsbTRwKh4JV5GTu9mBHgHFxpHeQ",
  "B96dV3Luxzo6SokJx3xt8i5y8Mb7HRR6Eec8hCjJDT69",
  "DwMLtdtJqJQkHzNcrdTBuWHJByJfgpKBnvFvzyKdy3cU",
  "8QJmxZcEzwuYmCPy6XqgN2sHcYCcFq6AEfBMJZZuLo5a",
  "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
  "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
  "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
  "EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX",
  "T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT",
  "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH",
  // Garden's Solana swap programs (SPL tokens, SOL), from its /v2/assets.
  "gdnvdMCHJgnidtU7SL8RkRshHPvDJU1pdfZEpoLvqdU",
  "2bag6xpshpvPe7SJ9nSDLHpxqhEAoHPGpEkjNSv7gxoF",
]);
