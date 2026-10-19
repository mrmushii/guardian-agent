import { eq } from "drizzle-orm";
import { isHex } from "viem";
import { userOperations } from "@guardian/db";
import { submitMasterSignature } from "@guardian/engine";
import { HttpError, json, requireOwner, route } from "@/lib/server";
/** Receives the owner wallet's signature over the prepared userOpHash; the engine verifies it recovers the master owner. */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { account, ctx } = await requireOwner(); const { id } = await params;
  const { signature } = (await req.json()) as { signature?: string };
  if (!signature || !isHex(signature)) throw new HttpError(400, "A wallet signature is required");
  const [op] = await ctx.db.select({ accountId: userOperations.accountId }).from(userOperations).where(eq(userOperations.id, id));
  if (op?.accountId !== account.id) throw new HttpError(404, "Operation not found");
  return json(await submitMasterSignature(ctx, id, signature));
});
