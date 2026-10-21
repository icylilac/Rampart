import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Where a project's webhooks may go. A webhook URL is chosen by whoever signs
 * up, and the worker POSTs to it, so it must not reach the network Rampart
 * runs in: private, loopback and link-local addresses (cloud metadata lives at
 * 169.254.169.254) are refused. Only in development may it be localhost.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64: can map to any IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The IPv4 address inside an IPv4-mapped IPv6 one (::ffff:a.b.c.d or ::ffff:XXXX:XXXX), if it is one. */
function mappedIPv4(ip: string): string | null {
  const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Whether an IP address is on the public internet (not private, loopback, link-local or reserved). */
export function isPublicAddress(ip: string): boolean {
  const v4 = isIP(ip) === 4 ? ip : mappedIPv4(ip);
  if (v4) return !blocked.check(v4, "ipv4");
  if (isIP(ip) === 6) return !blocked.check(ip, "ipv6");
  return false;
}

const isLoopback = (ip: string) => {
  const v4 = isIP(ip) === 4 ? ip : mappedIPv4(ip);
  return v4 ? v4.startsWith("127.") : ip === "::1";
};

/**
 * Checks a webhook URL without resolving it: https (http only for localhost
 * in development), and no host that is a non-public IP address or localhost.
 * Returns why it's refused, or null.
 */
export function webhookUrlProblem(value: string, allowLocal: boolean): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "Must be a valid URL.";
  }
  const local = LOCAL_HOSTNAMES.has(u.hostname) || u.hostname.endsWith(".localhost");
  if (local) return allowLocal ? null : "Must be a public https URL (localhost is allowed in development only).";
  if (u.protocol !== "https:") return "Must be an https URL.";
  if (u.username || u.password) return "Must not contain a username or password.";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) return "Must not point at a private, loopback or link-local address.";
  return null;
}

export type ResolveHost = (hostname: string) => Promise<string[]>;

export const resolveHost: ResolveHost = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Checks a webhook URL right before a delivery: the static checks above, then
 * every address its hostname resolves to must be public, so a DNS name can't
 * point the worker at an internal service. Throws with the reason if not.
 */
export async function assertDeliverable(value: string, allowLocal: boolean, resolve: ResolveHost = resolveHost): Promise<void> {
  const problem = webhookUrlProblem(value, allowLocal);
  if (problem) throw new Error(`Webhook URL refused: ${problem}`);
  const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0) throw new Error(`Webhook URL refused: ${host} does not resolve.`);
  for (const ip of addresses) {
    if (isPublicAddress(ip) || (allowLocal && isLoopback(ip))) continue;
    throw new Error(`Webhook URL refused: ${host} resolves to ${ip}, which is not a public address.`);
  }
}
