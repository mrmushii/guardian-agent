// Generates testnet-only private keys into .env. Never overwrites a key that is already set.
// Prints only the derived addresses.
import { readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const VARS = ["TESTNET_OWNER_PRIVATE_KEY", "TESTNET_WALLET_B_PRIVATE_KEY", "TESTNET_HARNESS_PRIVATE_KEY"];
let env = readFileSync(".env", "utf8");

for (const name of VARS) {
  const match = env.match(new RegExp(`^${name}=(.*)$`, "m"));
  if (!match) throw new Error(`${name} missing from .env`);
  let key = match[1]!.trim() as `0x${string}`;
  if (!key) {
    key = generatePrivateKey();
    env = env.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${key}`);
  }
  console.log(`${name.replace("_PRIVATE_KEY", "")}: ${privateKeyToAccount(key).address}`);
}
writeFileSync(".env", env, { mode: 0o600 });
