import { eq } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { appendAudit, policies } from "@guardian/db";
import { HumanPolicySchema, withTargets, type HumanPolicy } from "@guardian/policy";
import { createMasterAccount, createSponsoredClient } from "@guardian/account";
import { readReferencePrices } from "@guardian/oracle";
import type { EngineContext } from "./context.js";
import { loadAccountState } from "./state.js";
import { explorerTx } from "./userops.js";

const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"]);
const routerAbi = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);

/** Testnet-only demo sender ("Wallet B"): a separate sponsored smart account that moves funds into the Guardian account. */
export function demoWallet(ctx: EngineContext, env: NodeJS.ProcessEnv = process.env) {
  const key = env.TESTNET_WALLET_B_PRIVATE_KEY as Hex | undefined;
  if (!ctx.network.isTestnet || !key) return null;
  return privateKeyToAccount(key);
}

const usdFromWei = (wei: bigint, answer: bigint, decimals: number) => Number((wei * answer) / 10n ** BigInt(decimals) / 10n ** 14n) / 1e4;

export async function walletBBalances(ctx: EngineContext) {
  const signer = demoWallet(ctx);
  if (!signer) return null;
  const { account } = await createMasterAccount(ctx.publicClient, signer);
  const [weth, usdc, prices] = await Promise.all([
    ctx.publicClient.readContract({ address: ctx.network.weth, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    ctx.publicClient.readContract({ address: ctx.network.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    readReferencePrices(ctx.publicClient, ctx.network),
  ]);
  return { address: account.address, wethUsd: usdFromWei(weth, prices.wethUsd.answer, prices.wethUsd.decimals), usdc: Number(usdc) / 1e6 };
}

/**
 * Simulated market move for demos (testnet only): Wallet B pushes the Guardian account's WETH weight
 * up (sends WETH) or down (sends USDC; if it has too little USDC it swaps its WETH to USDC straight into the account).
 */
export async function simulateMove(ctx: EngineContext, accountId: string, guardian: Address, direction: "up" | "down", usd: number) {
  const signer = demoWallet(ctx);
  if (!signer) throw new Error("Simulation is only available on testnet with a demo wallet configured");
  if (!(usd >= 1 && usd <= 30)) throw new Error("Amount must be between $1 and $30");
  const prices = await readReferencePrices(ctx.publicClient, ctx.network);
  const cents = BigInt(Math.round(usd * 100));
  const wei = (cents * 10n ** BigInt(16 + prices.wethUsd.decimals)) / prices.wethUsd.answer;
  const { account: b } = await createMasterAccount(ctx.publicClient, signer);
  const bal = (token: Address) => ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [b.address] });
  const n = ctx.network;
  let calls: { to: Address; value: bigint; data: Hex }[];
  let how: string;
  if (direction === "up") {
    if ((await bal(n.weth)) < wei) throw new Error(`Demo wallet has too little WETH for $${usd}`);
    calls = [{ to: n.weth, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [guardian, wei] }) }];
    how = `sent $${usd} of WETH`;
  } else {
    const raw = cents * 10_000n;
    if ((await bal(n.usdc)) >= raw) {
      calls = [{ to: n.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [guardian, raw] }) }];
      how = `sent $${usd} of USDC`;
    } else {
      if ((await bal(n.weth)) < wei) throw new Error(`Demo wallet has too little USDC or WETH for $${usd}`);
      let best = { fee: 0, out: 0n };
      for (const fee of [500, 3000]) {
        try {
          const q = await ctx.publicClient.simulateContract({ address: n.quoterV2, abi: quoterAbi, functionName: "quoteExactInputSingle",
            args: [{ tokenIn: n.weth, tokenOut: n.usdc, amountIn: wei, fee, sqrtPriceLimitX96: 0n }] });
          if (q.result[0] > best.out) best = { fee, out: q.result[0] };
        } catch { /* pool unusable for this size */ }
      }
      if (!best.out) throw new Error("No usable WETH→USDC pool for the demo swap");
      calls = [
        { to: n.weth, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [n.swapRouter02, wei] }) },
        { to: n.swapRouter02, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: n.weth, tokenOut: n.usdc, fee: best.fee,
          recipient: guardian, amountIn: wei, amountOutMinimum: (best.out * 99n) / 100n, sqrtPriceLimitX96: 0n }] }) },
      ];
      how = `swapped $${usd} of its WETH into ${(Number(best.out) / 1e6).toFixed(2)} USDC for your account (testnet pools pay above market)`;
    }
  }
  const client = createSponsoredClient(b, ctx.chain, ctx.publicClient, ctx.pimlicoApiKey);
  const userOpHash = await client.sendUserOperation({ calls });
  const r = await client.waitForUserOperationReceipt({ hash: userOpHash });
  const explorer = explorerTx(ctx, r.receipt.transactionHash);
  await appendAudit(ctx.db, { accountId, type: "DEMO_MOVE", level: "INFO", message: `Simulated market move: demo wallet ${how}`,
    data: { direction, usd, userOpHash, transactionHash: r.receipt.transactionHash, explorer } });
  return { direction, usd, how, userOpHash, transactionHash: r.receipt.transactionHash, explorer, success: r.success };
}

/** Owner publishes a new policy version (validated). The on-chain permission changes only after the owner authorizes again. */
export async function publishPolicy(ctx: EngineContext, accountId: string, patch: Partial<HumanPolicy>, fallback?: HumanPolicy) {
  const st = await loadAccountState(ctx, accountId);
  const base = st.policy ?? fallback;
  if (!base) throw new Error("No existing policy to update");
  // Multi-asset targets keep the legacy WETH band consistent (target ± drift); `assets: null` returns to WETH/USDC.
  const merged = { ...base, ...patch } as HumanPolicy & { assets?: HumanPolicy["assets"] | null };
  if (merged.assets === null) { delete merged.assets; delete merged.driftPct; }
  const next = HumanPolicySchema.parse(merged.assets && merged.driftPct !== undefined ? withTargets(merged, merged.assets, merged.driftPct) : merged);
  const version = (st.policyRow?.version ?? 0) + 1;
  await ctx.db.transaction(async (tx) => {
    await tx.update(policies).set({ active: false }).where(eq(policies.accountId, accountId));
    await tx.insert(policies).values({ accountId, version, policy: next, active: true });
  });
  await appendAudit(ctx.db, { accountId, type: "POLICY_UPDATED", level: "INFO", message: `Owner published policy v${version}`, data: next });
  return { version, policy: next };
}
