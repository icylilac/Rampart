import { describe, expect, it } from "vitest";
import { assertDeliverable, isPublicAddress, webhookUrlProblem } from "../src/lib/webhook-target";

describe("webhook targets", () => {
  it("tells public addresses from private, loopback and link-local ones", () => {
    for (const ip of ["8.8.8.8", "203.0.113.7", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      "10.0.0.5",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.3.4",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.5",
      "::ffff:a9fe:a9fe", // 169.254.169.254
      "64:ff9b::a00:5",
      "not an ip",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("refuses non-https, credentials, internal IP literals and localhost outside development", () => {
    for (const bad of [
      "http://hooks.example/ramp",
      "ftp://hooks.example/",
      "https://user:pw@hooks.example/",
      "https://10.0.0.5/hooks",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "http://localhost:3000/hooks",
      "https://app.localhost/hooks",
    ]) {
      expect(webhookUrlProblem(bad, false), bad).not.toBeNull();
    }
    expect(webhookUrlProblem("https://hooks.example/ramp", false)).toBeNull();
    expect(webhookUrlProblem("https://203.0.113.7/ramp", false)).toBeNull();
    expect(webhookUrlProblem("http://localhost:3000/hooks", true)).toBeNull();
    expect(webhookUrlProblem("https://10.0.0.5/hooks", true)).not.toBeNull();
  });

  it("refuses a hostname that resolves to an internal address", async () => {
    await expect(assertDeliverable("https://hooks.example/", false, async () => ["203.0.113.7"])).resolves.toBeUndefined();
    await expect(assertDeliverable("https://internal.example/", false, async () => ["169.254.169.254"])).rejects.toThrow(/not a public address/);
    // One bad address among several is enough to refuse.
    await expect(assertDeliverable("https://mixed.example/", false, async () => ["203.0.113.7", "10.0.0.5"])).rejects.toThrow(/10\.0\.0\.5/);
    await expect(assertDeliverable("https://empty.example/", false, async () => [])).rejects.toThrow(/does not resolve/);
    // Development may use localhost, but still not the private network.
    await expect(assertDeliverable("http://localhost:3000/", true, async () => ["127.0.0.1"])).resolves.toBeUndefined();
    await expect(assertDeliverable("https://lan.example/", true, async () => ["192.168.1.10"])).rejects.toThrow();
  });
});
