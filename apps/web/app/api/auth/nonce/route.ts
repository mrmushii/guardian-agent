import { generateSiweNonce } from "viem/siwe";
import { getAddress, isAddress } from "viem";
import { authNonces } from "@guardian/db";
import { engine, json, route, HttpError } from "@/lib/server";

export const POST = route(async (req: Request) => {
  const { address } = (await req.json()) as { address?: string };
  if (!address || !isAddress(address)) throw new HttpError(400, "A wallet address is required");
  const nonce = generateSiweNonce();
  await engine().db.insert(authNonces).values({ nonce, walletAddress: getAddress(address).toLowerCase(), expiresAt: new Date(Date.now() + 10 * 60_000) });
  return json({ nonce, chainId: engine().chain.id });
});
