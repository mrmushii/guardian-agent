import type { Address } from "viem";

/**
 * Asset registry. Every managed asset trades only against USDC (the hub). An asset is tradable on-chain on a network
 * only after `verifyAsset` passes there (token, fresh Chainlink feed, USDC pool that quotes); otherwise it can be
 * tracked in simulated ("paper") mode when a price feed exists. Base Sepolia addresses below were read on-chain
 * 2026-10-18 (feed `description()`, token `symbol()`/`decimals()`, factory `getPool(token, USDC, fee)`).
 */
export type AssetKind = "stable" | "volatile";
export interface AssetDeployment {
  token?: Address;
  /** Chainlink <ASSET>/USD proxy on this network. */
  feed?: Address;
  /** Uniswap v3 fee tier of the asset/USDC pool to trade through. */
  feeTier?: number;
  /** Max feed age before prices are treated as stale (stablecoin feeds update rarely). */
  maxFeedAgeSec?: number;
}
export interface AssetDef {
  symbol: string;
  name: string;
  decimals: number;
  kind: AssetKind;
  /** The USDC hub is required in every portfolio. */
  hub?: boolean;
  deployments: Record<number, AssetDeployment>;
}

const DAY = 86_400;
export const SEPOLIA = 84532, MAINNET = 8453;

export const ASSETS: AssetDef[] = [
  { symbol: "USDC", name: "USD Coin", decimals: 6, kind: "stable", hub: true, deployments: {
    [SEPOLIA]: { token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", feed: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165", maxFeedAgeSec: 25 * 3600 },
    [MAINNET]: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  } },
  { symbol: "WETH", name: "Wrapped Ether", decimals: 18, kind: "volatile", deployments: {
    [SEPOLIA]: { token: "0x4200000000000000000000000000000000000006", feed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1", feeTier: 3000, maxFeedAgeSec: 3600 },
    [MAINNET]: { token: "0x4200000000000000000000000000000000000006", feeTier: 500 },
  } },
  { symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8, kind: "volatile", deployments: {
    [SEPOLIA]: { token: "0xcbB7C0006F23900c38EB856149F799620fcb8A4a", feed: "0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298", feeTier: 500, maxFeedAgeSec: 3600 },
    [MAINNET]: { token: "0xcbB7C0006F23900c38EB856149F799620fcb8A4a" },
  } },
  { symbol: "LINK", name: "Chainlink", decimals: 18, kind: "volatile", deployments: {
    [SEPOLIA]: { token: "0xE4aB69C077896252FAFBD49EFD26B5D171A32410", feed: "0xb113F5A928BCfF189C998ab20d753a47F9dE5A61", feeTier: 10000, maxFeedAgeSec: 3600 },
  } },
  { symbol: "DAI", name: "Dai Stablecoin", decimals: 18, kind: "stable", deployments: {
    [SEPOLIA]: { feed: "0xD1092a65338d049DB68D7Be6bD89d17a0929945e", maxFeedAgeSec: DAY + 3600 },
  } },
  { symbol: "USDT", name: "Tether USD", decimals: 6, kind: "stable", deployments: {
    [SEPOLIA]: { feed: "0x3ec8593F930EA45ea58c968260e6e9FF53FC934f", maxFeedAgeSec: DAY + 3600 },
  } },
  // No Base Sepolia feed or token for AERO: listed so the owner sees it, disabled until verified on a network.
  { symbol: "AERO", name: "Aerodrome", decimals: 18, kind: "volatile", deployments: {} },
];

export const assetBySymbol = (symbol: string) => ASSETS.find((a) => a.symbol.toLowerCase() === symbol.toLowerCase());
export const HUB_SYMBOL = "USDC";
