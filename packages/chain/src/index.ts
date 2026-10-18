import type { Address } from "viem";

/**
 * Addresses verified on-chain during Gate 0 (scripts/gate0/verify-addresses.ts, 2026-10-14):
 * token symbol/decimals, router WETH9()/factory(), 7-field exactInputSingle selector present
 * (no deadline variant), Quoter factory, pool existence and liquidity, Chainlink feed descriptions.
 */
export interface NetworkConfig {
  chainId: number;
  entryPoint: Address;
  weth: Address;
  usdc: Address;
  swapRouter02: Address;
  quoterV2: Address;
  uniswapV3Factory: Address;
  /** Selected WETH/USDC pool fee tier. */
  feeTier: number;
  pool: Address;
  chainlinkEthUsd: Address;
  chainlinkUsdcUsd: Address;
  /** Chainlink L2 sequencer uptime feed (mainnet only; verified on-chain). */
  sequencerUptimeFeed?: Address;
  /** Testnet pools are not market-priced; actions are labeled accordingly. */
  isTestnet: boolean;
  /** Pimlico verifying paymaster observed in sponsorship responses. */
  paymaster: Address;
}

const ENTRYPOINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const PIMLICO_PAYMASTER: Address = "0x777777777777AeC03fd955926DbF81597e66834C";

export const BASE_SEPOLIA: NetworkConfig = {
  chainId: 84532,
  entryPoint: ENTRYPOINT_V07,
  weth: WETH,
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  swapRouter02: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
  quoterV2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
  uniswapV3Factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  // Deepest WETH/USDC liquidity on testnet. Its price is NOT market-representative (~2x Chainlink).
  feeTier: 3000,
  pool: "0x46880b404CD35c165EDdefF7421019F8dD25F4Ad",
  chainlinkEthUsd: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
  chainlinkUsdcUsd: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165",
  isTestnet: true,
  paymaster: PIMLICO_PAYMASTER,
};

export const BASE_MAINNET: NetworkConfig = {
  chainId: 8453,
  entryPoint: ENTRYPOINT_V07,
  weth: WETH,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  // Deep liquidity; quote for 0.001 WETH within 0.07% of the best tier observed.
  feeTier: 500,
  pool: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
  chainlinkEthUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  chainlinkUsdcUsd: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  sequencerUptimeFeed: "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433",
  isTestnet: false,
  // Mainnet sponsorship not yet verified; confirm before mainnet use.
  paymaster: PIMLICO_PAYMASTER,
};

export const networkByChainId = (chainId: number): NetworkConfig => {
  const n = [BASE_SEPOLIA, BASE_MAINNET].find((x) => x.chainId === chainId);
  if (!n) throw new Error(`Unsupported chain ${chainId}`);
  return n;
};
export * from "./assets.js";
