import { createPublicClient, http, type Chain, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { networkByChainId, type NetworkConfig } from "@guardian/chain";
import { createDb, type Db } from "@guardian/db";
import { keyringFromEnv, type Keyring } from "@guardian/account";
import { GeminiModel, OpenAIModel, type AgentModel } from "@guardian/agent";

export interface EngineContext {
  db: Db;
  publicClient: PublicClient;
  network: NetworkConfig;
  chain: Chain;
  pimlicoApiKey: string;
  keyring: Keyring;
  models: AgentModel[];
  close: () => Promise<void>;
}

/**
 * Builds the engine from server-side environment variables.
 * Mainnet is refused unless GUARDIAN_ALLOW_MAINNET=true (testnet-only until the owner approves).
 */
export function createEngineContext(env: NodeJS.ProcessEnv = process.env): EngineContext {
  const chainId = Number(env.GUARDIAN_CHAIN_ID ?? 84532);
  if (chainId === 8453 && env.GUARDIAN_ALLOW_MAINNET !== "true") throw new Error("Mainnet disabled: set GUARDIAN_ALLOW_MAINNET=true only after owner approval");
  const chain = chainId === 8453 ? base : baseSepolia;
  const rpc = chainId === 8453 ? env.BASE_MAINNET_RPC_URL : env.BASE_SEPOLIA_RPC_URL;
  const need = (k: string, v?: string) => { if (!v) throw new Error(`${k} is required`); return v; };
  const { db, close } = createDb(need("DATABASE_URL", env.DATABASE_URL));
  const models: AgentModel[] = [];
  if (env.GEMINI_API_KEY && env.LLM_MODEL) models.push(new GeminiModel(env.GEMINI_API_KEY, env.LLM_MODEL));
  if (env.OPENAI_API_KEY && env.LLM_FALLBACK_MODEL) models.push(new OpenAIModel(env.OPENAI_API_KEY, env.LLM_FALLBACK_MODEL));
  return {
    db, chain, network: networkByChainId(chainId),
    publicClient: createPublicClient({ chain, transport: http(need("RPC URL", rpc)) }) as PublicClient,
    pimlicoApiKey: need("PIMLICO_API_KEY", env.PIMLICO_API_KEY),
    keyring: keyringFromEnv(env), models, close,
  };
}
