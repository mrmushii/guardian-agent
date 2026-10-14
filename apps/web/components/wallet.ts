"use client";
import { createWalletClient, custom, getAddress, type Address, type Hex } from "viem";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
const provider = () => (globalThis as unknown as { ethereum?: Eip1193 }).ethereum;

export async function connectWallet(): Promise<Address> {
  const eth = provider();
  if (!eth) throw new Error("No browser wallet found. Install a wallet extension and import the owner account.");
  const [addr] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!addr) throw new Error("The wallet did not share an account");
  return getAddress(addr);
}

/** personal_sign over a raw 32-byte hash — what the Kernel ECDSA validator verifies. */
export async function signRaw(account: Address, hash: Hex) {
  const wallet = createWalletClient({ account, transport: custom(provider()!) });
  return wallet.signMessage({ account, message: { raw: hash } });
}

export async function signText(account: Address, message: string) {
  const wallet = createWalletClient({ account, transport: custom(provider()!) });
  return wallet.signMessage({ account, message });
}
