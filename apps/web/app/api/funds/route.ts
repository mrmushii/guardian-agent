import { formatEther, parseEther, type Address } from "viem";
import { prepareWrapEth } from "@guardian/engine";
import { HttpError, json, requireAccount, requireOwner, route } from "@/lib/server";

/** Where to send funds, plus the plain ETH that is waiting to be wrapped into WETH. */
export const GET = route(async () => {
  const { account, ctx } = await requireAccount();
  const eth = await ctx.publicClient.getBalance({ address: account.address as Address });
  return json({ address: account.address, network: ctx.chain.name, isTestnet: ctx.network.isTestnet, ethWei: eth.toString(), eth: formatEther(eth) });
});

/** Owner wraps ETH held by the smart account into WETH; returns the operation for the wallet to sign. */
export const POST = route(async (req: Request) => {
  const { account, ctx } = await requireOwner();
  const { eth } = ((await req.json().catch(() => ({}))) ?? {}) as { eth?: string };
  let wei: bigint;
  try { wei = parseEther(String(eth ?? "")); } catch { throw new HttpError(400, "Enter an amount of ETH, e.g. 0.01"); }
  try { return json(await prepareWrapEth(ctx, account.id, wei)); }
  catch (e) { throw new HttpError(400, (e as Error).message); }
});
