import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { generatePrivateKey } from "viem/accounts";
import { decryptSessionKey, encryptSessionKey, type Keyring } from "@guardian/account";

const ring: Keyring = { current: 1, keys: { 1: randomBytes(32) } };
const acct = "0x11Bc46A51a49d1424c6474fb318C904E451654b7", perm = "0xdeadbeef";

describe("session keystore", () => {
  it("round-trips and never stores plaintext", () => {
    const pk = generatePrivateKey();
    const blob = encryptSessionKey(ring, pk, acct, perm);
    expect(blob.encryptedKey).not.toContain(pk.slice(2));
    expect(decryptSessionKey(ring, blob, acct, perm)).toBe(pk);
  });
  it("fails when moved to another account/permission (AAD binding)", () => {
    const blob = encryptSessionKey(ring, generatePrivateKey(), acct, perm);
    expect(() => decryptSessionKey(ring, blob, acct, "0x00000001")).toThrow();
    expect(() => decryptSessionKey(ring, blob, "0x0000000000000000000000000000000000000001", perm)).toThrow();
  });
  it("fails on tampering and on wrong key version", () => {
    const blob = encryptSessionKey(ring, generatePrivateKey(), acct, perm);
    const raw = Buffer.from(blob.encryptedKey, "base64"); raw[raw.length - 1]! ^= 1;
    expect(() => decryptSessionKey(ring, { ...blob, encryptedKey: raw.toString("base64") }, acct, perm)).toThrow();
    expect(() => decryptSessionKey(ring, { ...blob, keyVersion: 2 }, acct, perm)).toThrow();
  });
});
