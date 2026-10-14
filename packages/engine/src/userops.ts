import { eq } from "drizzle-orm";
import { http, type Address, type Hex, type LocalAccount } from "viem";
import { toAccount } from "viem/accounts";
import { createBundlerClient, formatUserOperationRequest, getUserOperationHash, type UserOperation } from "viem/account-abstraction";
import { transactions, userOperations } from "@guardian/db";
import { ENTRY_POINT, createMasterAccount, createSponsoredClient, pimlicoUrl, type HexCall } from "@guardian/account";
import type { EngineContext } from "./context.js";

type Op = UserOperation<"0.7">;
export const serializeOp = (op: Op) => JSON.parse(JSON.stringify(op, (_, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v)));
const BIG = ["nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"];
export const deserializeOp = (j: Record<string, unknown>): Op => {
  const o: Record<string, unknown> = { ...j };
  for (const k of BIG) if (o[k] !== undefined && o[k] !== null) o[k] = BigInt(o[k] as string);
  return o as unknown as Op;
};
export const opHash = (ctx: EngineContext, op: Op) =>
  getUserOperationHash({ userOperation: op, entryPointAddress: ENTRY_POINT.address, entryPointVersion: "0.7", chainId: ctx.chain.id });

export const bundler = (ctx: EngineContext) => createBundlerClient({ transport: http(pimlicoUrl(ctx.chain.id, ctx.pimlicoApiKey)), client: ctx.publicClient });

/** Signer that knows only the owner's address: the server can prepare master ops but never sign them. */
export function addressOnlySigner(address: Address): LocalAccount {
  const refuse = async (): Promise<never> => { throw new Error("Master signatures come from the owner's wallet"); };
  return toAccount({ address, signMessage: refuse, signTransaction: refuse, signTypedData: refuse }) as LocalAccount;
}

/** Prepares (estimates + sponsors) a master UserOperation for the owner's wallet to sign. */
export async function prepareMasterOp(ctx: EngineContext, owner: Address, calls: HexCall[]) {
  const { account } = await createMasterAccount(ctx.publicClient, addressOnlySigner(owner));
  const client = createSponsoredClient(account, ctx.chain, ctx.publicClient, ctx.pimlicoApiKey);
  const op = (await client.prepareUserOperation({ calls })) as Op;
  op.signature = "0x";
  return { op, userOpHash: opHash(ctx, op) };
}

export class BundlerRejection extends Error {}

/**
 * Submits a signed op. Bundler validation errors are definitive (nothing broadcast) → BundlerRejection.
 * Anything else (timeout, transport) is an UNKNOWN outcome and must be reconciled, never assumed failed.
 */
export async function submitSignedOp(ctx: EngineContext, rowId: string, op: Op): Promise<Hex> {
  await ctx.db.update(userOperations).set({ state: "SUBMITTING", updatedAt: new Date() }).where(eq(userOperations.id, rowId));
  try {
    const hash = await bundler(ctx).request({ method: "eth_sendUserOperation", params: [formatUserOperationRequest(op), ENTRY_POINT.address] } as never) as Hex;
    await ctx.db.update(userOperations).set({ state: "SUBMITTED", userOpHash: hash, updatedAt: new Date() }).where(eq(userOperations.id, rowId));
    return hash;
  } catch (e) {
    const msg = (e as Error).message;
    const definitive = /AA\d\d|validation|reverted|signature|-32500|-32501|-32502|-32503|-32504|-32505|-32506|-32507/i.test(msg) && !/timeout|timed out|fetch failed|ECONN/i.test(msg);
    await ctx.db.update(userOperations).set({ state: definitive ? "REJECTED" : "UNKNOWN", bundlerResult: { error: msg.split("\n").slice(0, 3).join(" ").slice(0, 800) }, updatedAt: new Date() })
      .where(eq(userOperations.id, rowId));
    if (definitive) throw new BundlerRejection(msg.split("\n")[0]);
    throw e;
  }
}

/** Records inclusion; outer transaction success and inner UserOperation success are stored separately. */
export async function recordReceipt(ctx: EngineContext, rowId: string, r: Awaited<ReturnType<ReturnType<typeof bundler>["getUserOperationReceipt"]>>, effects?: unknown) {
  await ctx.db.insert(transactions).values({
    userOperationId: rowId, chainId: ctx.chain.id, transactionHash: r.receipt.transactionHash, blockNumber: r.receipt.blockNumber,
    bundler: r.receipt.from, outerSuccess: r.receipt.status === "success", userOpSuccess: r.success,
    effects: effects === undefined ? null : JSON.parse(JSON.stringify(effects, (_, v) => (typeof v === "bigint" ? `${v}` : v))),
  }).onConflictDoNothing();
  await ctx.db.update(userOperations).set({ state: "INCLUDED", bundlerResult: { success: r.success, reason: r.reason ?? null }, updatedAt: new Date() }).where(eq(userOperations.id, rowId));
}

export const explorerTx = (ctx: EngineContext, hash: string) => `${ctx.chain.id === 8453 ? "https://basescan.org" : "https://sepolia.basescan.org"}/tx/${hash}`;
