import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config";

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

export const hmacHex = (key: string | Buffer, message: string) => createHmac("sha256", key).update(message).digest("hex");

export const hmacBase64 = (key: string | Buffer, message: string) =>
  createHmac("sha256", key).update(message).digest("base64");

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** AES-256-GCM, output: base64url(iv).base64url(tag).base64url(ciphertext). */
export function encrypt(plaintext: string, key = Buffer.from(config().ENCRYPTION_KEY, "base64")): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(payload: string, key = Buffer.from(config().ENCRYPTION_KEY, "base64")): string {
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !data) throw new Error("Malformed encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * Parses signature headers shaped like `t=123,v1=abc,v1=def` (Stripe) or
 * `t=123,s=abc` (MoonPay). Repeated keys are collected.
 */
export function parseSignatureHeader(header: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out.set(k, [...(out.get(k) ?? []), v]);
  }
  return out;
}
