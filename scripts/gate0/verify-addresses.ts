// Gate 0: verify candidate addresses by on-chain reads only (no transactions).
import { createPublicClient, http, parseAbi, toFunctionSelector, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";

const C = {
  [baseSepolia.id]: { name: "Base Sepolia", rpc: process.env.BASE_SEPOLIA_RPC_URL!, chain: baseSepolia,
    weth: "0x4200000000000000000000000000000000000006", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4", quoter: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
    factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    ethUsd: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1", usdcUsd: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165" },
  [base.id]: { name: "Base Mainnet", rpc: process.env.BASE_MAINNET_RPC_URL!, chain: base,
    weth: "0x4200000000000000000000000000000000000006", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481", quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    ethUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", usdcUsd: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B" },
} as const;
const ENTRYPOINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);
const routerAbi = parseAbi(["function WETH9() view returns (address)", "function factory() view returns (address)"]);
const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const poolAbi = parseAbi(["function liquidity() view returns (uint128)", "function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)", "function token0() view returns (address)"]);
const feedAbi = parseAbi(["function description() view returns (string)", "function decimals() view returns (uint8)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
const quoterAbi = parseAbi(["function factory() view returns (address)", "function WETH9() view returns (address)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"]);
const EXACT_INPUT_SINGLE_7 = toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))");
const EXACT_INPUT_SINGLE_8 = toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))");

const out: Record<string, unknown> = {};
for (const cfg of Object.values(C)) {
  const c = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
  const r: Record<string, unknown> = { chainId: await c.getChainId() };
  const code = async (a: Address) => (await c.getCode({ address: a }))?.length ?? 0;
  r.entryPointCodeBytes = await code(ENTRYPOINT);
  for (const t of ["weth", "usdc"] as const) r[t] = { address: cfg[t], symbol: await c.readContract({ address: cfg[t], abi: erc20, functionName: "symbol" }), decimals: await c.readContract({ address: cfg[t], abi: erc20, functionName: "decimals" }) };
  const routerCode = (await c.getCode({ address: cfg.router })) ?? "0x";
  r.router = { address: cfg.router, codeBytes: routerCode.length,
    WETH9: await c.readContract({ address: cfg.router, abi: routerAbi, functionName: "WETH9" }),
    factory: await c.readContract({ address: cfg.router, abi: routerAbi, functionName: "factory" }),
    has7FieldExactInputSingle: routerCode.includes(EXACT_INPUT_SINGLE_7.slice(2)),
    hasDeadlineVariant: routerCode.includes(EXACT_INPUT_SINGLE_8.slice(2)) };
  r.quoter = { address: cfg.quoter, factory: await c.readContract({ address: cfg.quoter, abi: quoterAbi, functionName: "factory" }) };
  const pools: unknown[] = [];
  for (const fee of [100, 500, 3000, 10000]) {
    const pool = await c.readContract({ address: cfg.factory, abi: factoryAbi, functionName: "getPool", args: [cfg.weth, cfg.usdc, fee] });
    if (pool === "0x0000000000000000000000000000000000000000") { pools.push({ fee, pool: null }); continue; }
    const amountIn = 10n ** 15n; // 0.001 WETH
    let quoteUsdc: string | null = null;
    try { const q = await c.simulateContract({ address: cfg.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: cfg.weth, tokenOut: cfg.usdc, amountIn, fee, sqrtPriceLimitX96: 0n }] }); quoteUsdc = (Number(q.result[0]) / 1e6).toFixed(6); } catch (e) { quoteUsdc = `quote failed: ${(e as Error).message.split("\n")[0]}`; }
    pools.push({ fee, pool, liquidity: `${await c.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" })}`,
      wethBalance: `${await c.readContract({ address: cfg.weth, abi: erc20, functionName: "balanceOf", args: [pool] })}`,
      usdcBalance: `${await c.readContract({ address: cfg.usdc, abi: erc20, functionName: "balanceOf", args: [pool] })}`,
      quoteFor0_001WETH_inUSDC: quoteUsdc });
  }
  r.pools = pools;
  for (const f of ["ethUsd", "usdcUsd"] as const) {
    try { const [, answer, , updatedAt] = await c.readContract({ address: cfg[f], abi: feedAbi, functionName: "latestRoundData" });
      r[f] = { address: cfg[f], description: await c.readContract({ address: cfg[f], abi: feedAbi, functionName: "description" }), decimals: await c.readContract({ address: cfg[f], abi: feedAbi, functionName: "decimals" }), answer: `${answer}`, ageSeconds: Math.floor(Date.now() / 1000) - Number(updatedAt) };
    } catch (e) { r[f] = { address: cfg[f], error: (e as Error).message.split("\n")[0] }; }
  }
  out[cfg.name] = r;
}
console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2));
