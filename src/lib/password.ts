import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt (node:crypto, no native dependency).
 * Stored as `scrypt$N$r$p$salt$hash`, so the cost can be raised later
 * without breaking existing hashes.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
// N * r * 128 bytes = 32 MiB; Node's default ceiling is exactly that, so raise it.
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, opts: ScryptOptions & { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, KEY_LEN, { ...opts, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(password, Buffer.from(salt, "base64url"), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A real hash of nothing in particular: checked when the email is unknown, so timing doesn't reveal it. */
let decoy: Promise<string> | undefined;
export const decoyHash = () => (decoy ??= hashPassword(randomBytes(16).toString("hex")));
