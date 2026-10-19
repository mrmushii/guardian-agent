import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

// Token amounts are lossless NUMERIC(78,0) strings; USD is integer cents. (architecture §9)
const amount = (name: string) => numeric(name, { precision: 78, scale: 0 });
const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Verified by wallet-signature login (lowercase address). */
  walletAddress: text("wallet_address").notNull().unique(),
  createdAt: created(),
});

export const authNonces = pgTable("auth_nonces", {
  nonce: text("nonce").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const smartAccounts = pgTable("smart_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  chainId: integer("chain_id").notNull(),
  address: text("address").notNull(),
  ownerAddress: text("owner_address").notNull(),
  kernelVersion: text("kernel_version").notNull(),
  entryPoint: text("entry_point").notNull(),
  /** Autonomous monitoring switch; false pauses new autonomous actions. */
  monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
  pausedReason: text("paused_reason"),
  createdAt: created(),
}, (t) => [uniqueIndex("smart_accounts_chain_address").on(t.chainId, t.address)]);

export const policies = pgTable("policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => smartAccounts.id),
  version: integer("version").notNull(),
  /** Owner-approved HumanPolicy JSON. */
  policy: jsonb("policy").notNull(),
  active: boolean("active").notNull().default(false),
  createdAt: created(),
}, (t) => [
  uniqueIndex("policies_account_version").on(t.accountId, t.version),
  uniqueIndex("policies_one_active").on(t.accountId).where(sql`${t.active}`),
]);

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => smartAccounts.id),
  /** v3: one permission (session key) per traded asset; legacy sessions are WETH. */
  asset: text("asset").notNull().default("WETH"),
  policyId: uuid("policy_id").notNull().references(() => policies.id),
  permissionId: text("permission_id").notNull(),
  signerAddress: text("signer_address").notNull(),
  /** AES-256-GCM blob (iv|tag|ciphertext, base64). Never plaintext. */
  encryptedKey: text("encrypted_key").notNull(),
  keyVersion: integer("key_version").notNull(),
  validAfter: timestamp("valid_after", { withTimezone: true }).notNull(),
  validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
  /** PENDING_AUTHORIZATION → ACTIVE → REVOKED | EXPIRED | REAUTH_REQUIRED; PENDING_REPLACEMENT → ACTIVE when a signed replacement revokes the old session */
  status: text("status").notNull(),
  authorizeUserOpHash: text("authorize_user_op_hash"),
  revokeUserOpHash: text("revoke_user_op_hash"),
  createdAt: created(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [uniqueIndex("agent_sessions_one_active").on(t.accountId).where(sql`${t.status} in ('PENDING_AUTHORIZATION','ACTIVE','REAUTH_REQUIRED')`)]);

export const policyCompilations = pgTable("policy_compilations", {
  id: uuid("id").primaryKey().defaultRandom(),
  policyId: uuid("policy_id").notNull().references(() => policies.id),
  sessionId: uuid("session_id").notNull().references(() => agentSessions.id).unique(),
  authPriceAnswer: amount("auth_price_answer").notNull(),
  authPriceDecimals: integer("auth_price_decimals").notNull(),
  authPriceSource: text("auth_price_source").notNull(),
  authPriceTimestamp: timestamp("auth_price_timestamp", { withTimezone: true }).notNull(),
  bufferBps: integer("buffer_bps").notNull(),
  maxAmountInWei: amount("max_amount_in_wei").notNull(),
  /** Ops per rate-limit window (v1: per session). */
  maxOps: integer("max_ops").notNull(),
  allowanceWei: amount("allowance_wei").notNull(),
  /** Permission layout (packages/account PermissionVersion). 1 = sell-only legacy, 2 = two-way + resetting window. */
  permissionVersion: integer("permission_version").notNull().default(1),
  /** v2 buy side: exactOutputSingle amountInMaximum ceiling and bounded USDC router allowance. */
  maxUsdcInRaw: amount("max_usdc_in_raw"),
  usdcAllowanceRaw: amount("usdc_allowance_raw"),
  /** v2 rate-limit window (seconds). */
  windowSec: integer("window_sec"),
  gasAllowanceWei: amount("gas_allowance_wei").notNull(),
  /** Target, selector, assets, recipient, fee tier, paymaster, policy contract addresses. */
  restrictions: jsonb("restrictions").notNull(),
  createdAt: created(),
});

/** Non-terminal states hold the per-account lock (plan §12: one active rebalance). */
export const ACTIVE_ACTION_STATES = [
  "TRIGGERED", "PLANNING", "SIMULATING", "PENDING_APPROVAL", "REVALIDATING", "MASTER_SIGNING", "SUBMITTING", "PENDING",
] as const;

export const agentActions = pgTable("agent_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => smartAccounts.id),
  policyId: uuid("policy_id").notNull().references(() => policies.id),
  sessionId: uuid("session_id").references(() => agentSessions.id),
  /** Idempotency key, e.g. "block:<n>" — duplicate triggers are ignored. */
  triggerKey: text("trigger_key").notNull(),
  trigger: jsonb("trigger").notNull(),
  triggerBlock: bigint("trigger_block", { mode: "bigint" }),
  state: text("state").notNull(),
  decision: jsonb("decision"),
  tier: text("tier"),
  reasons: jsonb("reasons"),
  /** Deterministic plan: amounts, quote, minOut, risk (bigints as strings). */
  plan: jsonb("plan"),
  requestedUsdCents: bigint("requested_usd_cents", { mode: "bigint" }),
  /** Budget reservation; released (0) on definitive failure or rejection. */
  reservedUsdCents: bigint("reserved_usd_cents", { mode: "bigint" }).notNull().default(sql`0`),
  budgetDay: date("budget_day"),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  error: text("error"),
  createdAt: created(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("agent_actions_trigger").on(t.accountId, t.triggerKey),
  uniqueIndex("agent_actions_one_active").on(t.accountId).where(sql`${t.state} in ('TRIGGERED','PLANNING','SIMULATING','PENDING_APPROVAL','REVALIDATING','MASTER_SIGNING','SUBMITTING','PENDING')`),
  index("agent_actions_budget").on(t.accountId, t.budgetDay),
]);

export const userOperations = pgTable("user_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  actionId: uuid("action_id").references(() => agentActions.id),
  accountId: uuid("account_id").notNull().references(() => smartAccounts.id),
  /** AGENT_SESSION | MASTER */
  authority: text("authority").notNull(),
  purpose: text("purpose").notNull(),
  nonce: amount("nonce"),
  userOpHash: text("user_op_hash").unique(),
  sessionId: uuid("session_id").references(() => agentSessions.id),
  /** Exact prepared UserOperation (bigints as strings). Master ops: what the owner is asked to sign. */
  payload: jsonb("payload"),
  /** INTENT → AWAITING_SIGNATURE → SUBMITTED → INCLUDED | REJECTED | UNKNOWN | ABANDONED */
  state: text("state").notNull(),
  bundlerResult: jsonb("bundler_result"),
  createdAt: created(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userOperationId: uuid("user_operation_id").notNull().references(() => userOperations.id).unique(),
  chainId: integer("chain_id").notNull(),
  transactionHash: text("transaction_hash").notNull(),
  blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
  bundler: text("bundler"),
  /** Outer tx status and inner UserOperationEvent.success are recorded separately. */
  outerSuccess: boolean("outer_success").notNull(),
  userOpSuccess: boolean("user_op_success").notNull(),
  effects: jsonb("effects"),
  createdAt: created(),
});

export const securityEvents = pgTable("security_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").references(() => smartAccounts.id),
  kind: text("kind").notNull(),
  reason: text("reason").notNull(),
  /** APPLICATION | BUNDLER | ONCHAIN */
  source: text("source").notNull(),
  evidence: jsonb("evidence"),
  createdAt: created(),
});

export const auditEvents = pgTable("audit_events", {
  /** Monotonic cursor for dashboard reload-after-reconnect. */
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  accountId: uuid("account_id").references(() => smartAccounts.id),
  actionId: uuid("action_id").references(() => agentActions.id),
  type: text("type").notNull(),
  /** INFO | SUCCESS | WARNING | FAILURE */
  level: text("level").notNull(),
  message: text("message").notNull(),
  data: jsonb("data"),
  createdAt: created(),
}, (t) => [index("audit_events_account").on(t.accountId, t.id)]);

export const watcherCheckpoints = pgTable("watcher_checkpoints", {
  accountId: uuid("account_id").primaryKey().references(() => smartAccounts.id),
  lastBlock: bigint("last_block", { mode: "bigint" }).notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  /** Latest precheck result for the live dashboard: { at, block, state, inBand, summary, nextCheckAt, recent[] }. */
  lastCheck: jsonb("last_check"),
});

/** Owner-added tokens (beyond the built-in registry), with the result of the last on-chain verification. */
export const customAssets = pgTable("custom_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => smartAccounts.id),
  chainId: integer("chain_id").notNull(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  token: text("token").notNull(),
  decimals: integer("decimals").notNull(),
  feed: text("feed"),
  feeTier: integer("fee_tier"),
  kind: text("kind").notNull().default("volatile"),
  /** VERIFIED (tradable on-chain) | PAPER (priced, simulated only) | REJECTED */
  status: text("status").notNull(),
  evidence: jsonb("evidence"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: created(),
}, (t) => [uniqueIndex("custom_assets_account_token").on(t.accountId, t.chainId, t.token)]);

/**
 * Simulated ("paper") positions for assets with no usable pool on this network. Quantities are raw token units.
 * The USDC row is the amount of real USDC notionally committed to paper positions (spent minus proceeds), so the
 * portfolio value is real balances − committed USDC + Σ paper quantity × oracle price.
 */
export const paperPositions = pgTable("paper_positions", {
  accountId: uuid("account_id").notNull().references(() => smartAccounts.id),
  chainId: integer("chain_id").notNull(),
  symbol: text("symbol").notNull(),
  qtyRaw: numeric("qty_raw", { precision: 78, scale: 0 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("paper_positions_key").on(t.accountId, t.chainId, t.symbol)]);
