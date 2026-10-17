import { GUARDIAN_CONFIG, WETH_DECIMALS, type UsdPrice } from "@guardian/policy";

export type RiskClass = "LOW" | "MEDIUM" | "HIGH";
export interface RiskInput {
  /** WETH leg of the trade (wei): sold for a sell, bought for a buy. */
  wethWei: bigint;
  /** USDC leg (6 decimals): quoted output for a sell, quoted input for a buy. */
  usdcRaw: bigint;
  poolWethReserve: bigint;
  wethUsd: UsdPrice;
  usdcUsd: UsdPrice;
  requestedUsdCents: bigint;
  dailyBudgetUsdCents: bigint;
  maxDivergenceBps: number;
}
export interface RiskResult {
  score: number;
  classification: RiskClass;
  components: { liquidity: number; slippage: number; size: number; protocol: number; token: number };
  divergenceBps: number;
  usdcDeviationBps: number;
  /** Disqualifying conditions (E2). Any gate ⇒ HIGH regardless of score. */
  hardGates: string[];
}

const clamp = (x: number) => Math.max(0, Math.min(100, x));
const bpsDiff = (a: bigint, b: bigint) => Number(((a > b ? a - b : b - a) * 10_000n) / b);

/** Deterministic risk (plan §9, docs/decisions.md D4/E1/E2). The LLM never computes this. */
export function assessRisk(r: RiskInput): RiskResult {
  const cfg = GUARDIAN_CONFIG;
  // Execution price (USD per WETH, 8dp) implied by the quote, valued at the USDC oracle price. Same for both directions.
  const quoteUsd8 = (r.usdcRaw * r.usdcUsd.answer * 10n ** BigInt(WETH_DECIMALS + 8)) / (r.wethWei * 10n ** BigInt(6 + r.usdcUsd.decimals));
  const oracleUsd8 = (r.wethUsd.answer * 10n ** 8n) / 10n ** BigInt(r.wethUsd.decimals);
  const divergenceBps = bpsDiff(quoteUsd8, oracleUsd8);
  const usdcDeviationBps = bpsDiff(r.usdcUsd.answer, 10n ** BigInt(r.usdcUsd.decimals));
  const shareBps = r.poolWethReserve === 0n ? 10_000 : Number((r.wethWei * 10_000n) / r.poolWethReserve);

  const components = {
    liquidity: clamp((100 * shareBps) / cfg.liquidityFullScoreShareBps),
    slippage: clamp((100 * divergenceBps) / r.maxDivergenceBps),
    size: clamp(Number((r.requestedUsdCents * 100n) / r.dailyBudgetUsdCents)),
    protocol: cfg.staticProtocolScore,
    token: usdcDeviationBps > cfg.usdcDepegBps ? 100 : cfg.staticTokenScore,
  };
  const w = cfg.riskWeights;
  const score = Math.round(w.liquidity * components.liquidity + w.slippage * components.slippage + w.size * components.size + w.protocol * components.protocol + w.token * components.token);

  const hardGates: string[] = [];
  if (divergenceBps > r.maxDivergenceBps) hardGates.push(`PRICE_DIVERGENCE_${divergenceBps}BPS`);
  if (usdcDeviationBps > cfg.usdcDepegBps) hardGates.push(`USDC_DEPEG_${usdcDeviationBps}BPS`);
  if (r.poolWethReserve === 0n) hardGates.push("NO_LIQUIDITY");

  const classification: RiskClass = hardGates.length || score > 60 ? "HIGH" : score > 30 ? "MEDIUM" : "LOW";
  return { score, classification, components, divergenceBps, usdcDeviationBps, hardGates };
}
