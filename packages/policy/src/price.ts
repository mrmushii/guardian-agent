/** Fixed-point USD price, e.g. a Chainlink answer with its feed decimals. */
export interface UsdPrice {
  answer: bigint;
  decimals: number;
}

export function assertValidPrice(p: UsdPrice): void {
  if (p.answer <= 0n) throw new Error("Price must be positive");
  if (!Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 36) throw new Error("Invalid price decimals");
}
