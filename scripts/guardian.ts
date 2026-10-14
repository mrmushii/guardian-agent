// Guardian operator CLI (TESTNET). The owner test key stands in for the browser wallet:
// the engine prepares master ops, the owner signs the userOpHash, the engine verifies and submits.
//   register | status | authorize | revoke | approve <actionId> | decline <actionId> | reconcile | resume
//   evaluate | fund-weth <eth> | buy-weth <usdc> | balance-portfolio
//   b-address | b-buy-weth <usdc> | send-weth <usd>   (Wallet B sponsored smart account → Guardian, demo trigger)
import { and, desc, eq } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, parseEther, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentActions, appendAudit, policies, smartAccounts, users } from "@guardian/db";
import { createMasterAccount, createSponsoredClient, KERNEL_VERSION, ENTRY_POINT } from "@guardian/account";
import { createEngineContext, declineApproval, loadAccountState, prepareApproval, prepareAuthorization, prepareRevocation, readPortfolio,
  reconcile, runRebalance, sessionStatus, submitMasterSignature, fmtBps, fmtUsd18, bundler } from "@guardian/engine";
import { readReferencePrices } from "@guardian/oracle";

if (process.env.GUARDIAN_CHAIN_ID && process.env.GUARDIAN_CHAIN_ID !== "84532") throw new Error("CLI is testnet-only");
const ctx = createEngineContext({ ...process.env, GUARDIAN_CHAIN_ID: "84532" });
const owner = privateKeyToAccount(process.env.TESTNET_OWNER_PRIVATE_KEY as Hex);
const DEFAULT_POLICY = { ethMinPct: 45, ethMaxPct: 55, targetEthPct: 53, maxAutoTxUsd: 10, dailyBudgetUsd: 25, maxSlippageBps: 50, sessionDurationHours: 24 };
const out = (o: unknown) => console.log(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2));

async function accountId() {
  const { account } = await createMasterAccount(ctx.publicClient, owner);
  const [row] = await ctx.db.select().from(smartAccounts).where(and(eq(smartAccounts.chainId, ctx.chain.id), eq(smartAccounts.address, account.address)));
  if (!row) throw new Error("Not registered: run `register`");
  return row.id;
}

async function signAndSubmit(p: { userOperationId: string; userOpHash: Hex }) {
  const signature = await owner.signMessage({ message: { raw: p.userOpHash } }); // what the wallet does
  const { userOpHash } = await submitMasterSignature(ctx, p.userOperationId, signature);
  const r = await bundler(ctx).waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000 });
  await reconcile(ctx);
  return { userOpHash, success: r.success, transactionHash: r.receipt.transactionHash, explorer: `https://sepolia.basescan.org/tx/${r.receipt.transactionHash}` };
}

const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"]);
const routerAbi = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);
const walletB = privateKeyToAccount(process.env.TESTNET_WALLET_B_PRIVATE_KEY as Hex);

/** Best USDC→WETH quote across the verified Sepolia pools. */
async function bestUsdcToWeth(usdcRaw: bigint) {
  let best = { fee: 0, out: 0n };
  for (const fee of [500, 3000]) {
    try { const q = await ctx.publicClient.simulateContract({ address: ctx.network.quoterV2, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ tokenIn: ctx.network.usdc, tokenOut: ctx.network.weth, amountIn: usdcRaw, fee, sqrtPriceLimitX96: 0n }] });
      if (q.result[0] > best.out) best = { fee, out: q.result[0] }; } catch { /* pool unusable for this size */ }
  }
  if (!best.out) throw new Error("No usable USDC→WETH pool");
  return best;
}

/** Setup-only master action (owner key signs): swap USDC→WETH into the same account, gas sponsored. */
async function masterBuyWeth(signer: typeof owner, usdcRaw: bigint) {
  const { account } = await createMasterAccount(ctx.publicClient, signer);
  const { fee, out } = await bestUsdcToWeth(usdcRaw);
  const client = createSponsoredClient(account, ctx.chain, ctx.publicClient, ctx.pimlicoApiKey);
  const hash = await client.sendUserOperation({ calls: [
    { to: ctx.network.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ctx.network.swapRouter02, usdcRaw] }) },
    { to: ctx.network.swapRouter02, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: ctx.network.usdc, tokenOut: ctx.network.weth, fee, recipient: account.address, amountIn: usdcRaw, amountOutMinimum: (out * 99n) / 100n, sqrtPriceLimitX96: 0n }] }) },
  ] });
  const r = await client.waitForUserOperationReceipt({ hash });
  return { account: account.address, usdcIn: Number(usdcRaw) / 1e6, feeTier: fee, expectedWethWei: out, userOpHash: hash, success: r.success, tx: r.receipt.transactionHash, explorer: `https://sepolia.basescan.org/tx/${r.receipt.transactionHash}` };
}
const usdc = (v: string | undefined, d: string) => BigInt(Math.round(Number(v ?? d) * 1e6));

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "register": {
    const { account } = await createMasterAccount(ctx.publicClient, owner);
    if (!(await ctx.publicClient.getCode({ address: account.address }))) throw new Error("Deploy first: scripts/setup-account.ts");
    const [user] = await ctx.db.insert(users).values({ walletAddress: owner.address.toLowerCase() }).onConflictDoUpdate({ target: users.walletAddress, set: { walletAddress: owner.address.toLowerCase() } }).returning();
    const [acct] = await ctx.db.insert(smartAccounts).values({ userId: user!.id, chainId: ctx.chain.id, address: account.address, ownerAddress: owner.address,
      kernelVersion: KERNEL_VERSION, entryPoint: ENTRY_POINT.address }).onConflictDoNothing().returning();
    const id = acct?.id ?? (await accountId());
    const [existing] = await ctx.db.select().from(policies).where(eq(policies.accountId, id));
    if (!existing) await ctx.db.insert(policies).values({ accountId: id, version: 1, policy: DEFAULT_POLICY, active: true });
    await appendAudit(ctx.db, { accountId: id, type: "ACCOUNT_REGISTERED", level: "INFO", message: `Smart account ${account.address} registered with policy v1` });
    out({ accountId: id, smartAccount: account.address, policy: DEFAULT_POLICY });
    break;
  }
  case "status": {
    const id = await accountId();
    const st = await loadAccountState(ctx, id);
    let portfolio: unknown = "unavailable";
    try { const s = await readPortfolio(ctx, st.account.address as Address, st.policy!); const v = s.assessment.valuation;
      portfolio = { wethWei: s.wethWei, usdcRaw: s.usdcRaw, wethUsd: fmtUsd18(v.wethUsd18), usdcUsd: fmtUsd18(v.usdcUsd18), wethWeightPct: fmtBps(v.wethWeightBps), assessment: s.assessment.kind };
    } catch (e) { portfolio = `unavailable: ${(e as Error).message}`; }
    const actions = await ctx.db.select({ id: agentActions.id, state: agentActions.state, tier: agentActions.tier, createdAt: agentActions.createdAt }).from(agentActions).where(eq(agentActions.accountId, id)).orderBy(desc(agentActions.createdAt)).limit(5);
    out({ account: { id, address: st.account.address, owner: st.account.ownerAddress, monitoring: st.account.monitoringEnabled, pausedReason: st.account.pausedReason },
      policy: st.policy, session: st.session && { status: st.session.status, onChain: await sessionStatus(ctx, st.account, st.session, st.compilation), permissionId: st.session.permissionId, signer: st.session.signerAddress, validUntil: st.session.validUntil },
      compiled: st.compilation && { maxAmountInWei: st.compilation.maxAmountInWei, maxOps: st.compilation.maxOps, allowanceWei: st.compilation.allowanceWei },
      portfolio, recentActions: actions });
    break;
  }
  case "authorize": { const p = await prepareAuthorization(ctx, await accountId()); out({ prepared: p.userOpHash, permissionId: p.permissionId, ...(await signAndSubmit(p)) }); break; }
  case "revoke": { out(await signAndSubmit(await prepareRevocation(ctx, await accountId()))); break; }
  case "approve": { const p = await prepareApproval(ctx, arg!); if (p.cancelled) { out(p); break; } out({ plan: p.plan, ...(await signAndSubmit(p)) }); break; }
  case "decline": { await declineApproval(ctx, arg!); out({ declined: arg }); break; }
  case "reconcile": { await reconcile(ctx); out({ ok: true }); break; }
  case "resume": { const id = await accountId(); await ctx.db.update(smartAccounts).set({ monitoringEnabled: true, pausedReason: null }).where(eq(smartAccounts.id, id)); await appendAudit(ctx.db, { accountId: id, type: "RESUMED", level: "INFO", message: "Owner resumed autonomous monitoring" }); out({ resumed: id }); break; }
  case "evaluate": { out(await runRebalance(ctx, await accountId(), { key: `manual:${Date.now()}`, kind: "MANUAL", detail: "Manual evaluation requested by owner" })); break; }
  case "fund-weth": { // master op: wrap ETH held by the smart account into WETH (sponsored)
    const { account } = await createMasterAccount(ctx.publicClient, owner);
    const client = createSponsoredClient(account, ctx.chain, ctx.publicClient, ctx.pimlicoApiKey);
    const hash = await client.sendUserOperation({ calls: [{ to: ctx.network.weth, value: parseEther(arg ?? "0.005"), data: encodeFunctionData({ abi: parseAbi(["function deposit() payable"]), functionName: "deposit" }) }] });
    const r = await client.waitForUserOperationReceipt({ hash }); out({ userOpHash: hash, success: r.success, tx: r.receipt.transactionHash }); break;
  }
  case "buy-weth": { out(await masterBuyWeth(owner, usdc(arg, "10"))); break; }
  case "balance-portfolio": { // swap the USDC amount that leaves WETH ≈ 50% at Chainlink valuation (testnet pools are off-market)
    const { account } = await createMasterAccount(ctx.publicClient, owner);
    const bal = await ctx.publicClient.readContract({ address: ctx.network.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    const prices = await readReferencePrices(ctx.publicClient, ctx.network);
    const probe = bal / 2n, { out: wethOut } = await bestUsdcToWeth(probe);
    // k = Chainlink USD value of WETH received per USD of USDC spent; solve x·k = bal − x.
    const k = (Number(wethOut) / 1e18) * (Number(prices.wethUsd.answer) / 1e8) / (Number(probe) / 1e6);
    const x = BigInt(Math.floor(Number(bal) / (1 + k)));
    out({ usdcBalance: Number(bal) / 1e6, valueRatioK: k.toFixed(4), swappingUsdc: Number(x) / 1e6, ...(await masterBuyWeth(owner, x)) }); break;
  }
  case "b-address": { const { account } = await createMasterAccount(ctx.publicClient, walletB); out({ walletB: account.address }); break; }
  case "b-buy-weth": { out(await masterBuyWeth(walletB, usdc(arg, "15"))); break; }
  case "send-weth": { // Wallet B (sponsored smart account) sends `arg` USD worth of WETH to the Guardian account (plan §13 trigger)
    const prices = await readReferencePrices(ctx.publicClient, ctx.network);
    const cents = BigInt(Math.round(Number(arg ?? "11.25") * 100));
    const wei = (cents * 10n ** BigInt(16 + prices.wethUsd.decimals)) / prices.wethUsd.answer;
    const { account: b } = await createMasterAccount(ctx.publicClient, walletB);
    const bal = await ctx.publicClient.readContract({ address: ctx.network.weth, abi: erc20Abi, functionName: "balanceOf", args: [b.address] });
    if (bal < wei) throw new Error(`Wallet B has ${bal} wei WETH, needs ${wei}. Run: b-buy-weth <usdc>`);
    const { account: guardian } = await createMasterAccount(ctx.publicClient, owner);
    const client = createSponsoredClient(b, ctx.chain, ctx.publicClient, ctx.pimlicoApiKey);
    const hash = await client.sendUserOperation({ calls: [{ to: ctx.network.weth, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [guardian.address, wei] }) }] });
    const r = await client.waitForUserOperationReceipt({ hash });
    out({ sentUsd: Number(cents) / 100, wei, from: b.address, userOpHash: hash, tx: r.receipt.transactionHash, explorer: `https://sepolia.basescan.org/tx/${r.receipt.transactionHash}` }); break;
  }
  default: console.log("commands: register | status | authorize | revoke | approve <id> | decline <id> | reconcile | resume | evaluate | fund-weth <eth> | buy-weth <usdc> | balance-portfolio | b-address | b-buy-weth <usdc> | send-weth <usd>");
}
await ctx.close();
