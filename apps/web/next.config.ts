import type { NextConfig } from "next";
import { resolve } from "node:path";

// Single source of secrets: the repository-root .env (server-side only; nothing is NEXT_PUBLIC_).
try { process.loadEnvFile(resolve(process.cwd(), "../../.env")); } catch { /* hosted env provides variables */ }

const config: NextConfig = {
  transpilePackages: ["@guardian/engine", "@guardian/db", "@guardian/policy", "@guardian/chain", "@guardian/account", "@guardian/agent",
    "@guardian/oracle", "@guardian/dex", "@guardian/risk", "@guardian/portfolio", "@guardian/simulation"],
  // Workspace packages use TypeScript ESM ".js" specifiers for ".ts" sources.
  webpack: (cfg) => { cfg.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] }; return cfg; },
  serverExternalPackages: ["postgres", "@zerodev/sdk", "@zerodev/permissions", "@zerodev/ecdsa-validator", "permissionless"],
};
export default config;
