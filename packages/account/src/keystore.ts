import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Hex } from "viem";

/**
 * Session-key encryption at rest (architecture §11): AES-256-GCM with a random 96-bit IV.
 * Associated data binds the ciphertext to its account and permission, so a blob copied onto
 * another session row fails to decrypt. Format: base64(iv | tag | ciphertext).
 */
export interface Keyring { current: number; keys: Record<number, Buffer> }

export function keyringFromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
  const hex = env.SESSION_KEY_ENCRYPTION_KEY, version = Number(env.SESSION_KEY_ENCRYPTION_KEY_VERSION ?? "1");
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error("SESSION_KEY_ENCRYPTION_KEY must be 32 bytes of hex");
  return { current: version, keys: { [version]: Buffer.from(hex, "hex") } };
}

const aad = (accountAddress: string, permissionId: string) => Buffer.from(`${accountAddress.toLowerCase()}|${permissionId.toLowerCase()}`);

export function encryptSessionKey(ring: Keyring, privateKey: Hex, accountAddress: string, permissionId: string) {
  const key = ring.keys[ring.current];
  if (!key) throw new Error("Current key version missing");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(aad(accountAddress, permissionId));
  const ct = Buffer.concat([cipher.update(privateKey.slice(2), "hex"), cipher.final()]);
  return { encryptedKey: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64"), keyVersion: ring.current };
}

export function decryptSessionKey(ring: Keyring, blob: { encryptedKey: string; keyVersion: number }, accountAddress: string, permissionId: string): Hex {
  const key = ring.keys[blob.keyVersion];
  if (!key) throw new Error(`Key version ${blob.keyVersion} unavailable`);
  const raw = Buffer.from(blob.encryptedKey, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)).setAAD(aad(accountAddress, permissionId));
  decipher.setAuthTag(raw.subarray(12, 28));
  return `0x${Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("hex")}`;
}
