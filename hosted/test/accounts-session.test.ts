/** The session cookie (issue #229). */
import { describe, expect, it } from "vitest";

import {
  clearSessionCookie,
  readSession,
  sessionCookie,
} from "../src/accounts/session.ts";

const NOW = Date.UTC(2026, 10, 24, 12);
const KEY = "session-key";
const ID = "acc_abc-DEF_123";

const requestWith = (setCookie: string): Request =>
  new Request("https://agentic-seo.org/account", {
    headers: { Cookie: setCookie.split(";")[0] ?? "" },
  });

const make = (value: string): Request =>
  new Request("https://x.test/", {
    headers: { Cookie: `__Host-account=${value}` },
  });

describe("session cookie", () => {
  it("round trips the account id", async () => {
    const cookie = await sessionCookie(ID, KEY, NOW);
    await expect(
      readSession(requestWith(cookie), KEY, NOW + 1000)
    ).resolves.toBe(ID);
  });

  it("rejects a changed id with the same signature", async () => {
    const cookie = await sessionCookie(ID, KEY, NOW);
    const forged = cookie.replace(ID, "acc_other");
    await expect(
      readSession(requestWith(forged), KEY, NOW)
    ).resolves.toBeNull();
  });

  it("rejects an expired cookie", async () => {
    const cookie = await sessionCookie(ID, KEY, NOW);
    const later = NOW + 31 * 86_400_000;
    await expect(
      readSession(requestWith(cookie), KEY, later)
    ).resolves.toBeNull();
  });

  it("rejects a cookie signed with another key", async () => {
    const cookie = await sessionCookie(ID, "other", NOW);
    await expect(
      readSession(requestWith(cookie), KEY, NOW)
    ).resolves.toBeNull();
  });

  it("rejects malformed values and a missing cookie", async () => {
    await expect(readSession(make("a.b"), KEY, NOW)).resolves.toBeNull();
    await expect(readSession(make("a.1.2.3"), KEY, NOW)).resolves.toBeNull();
    await expect(readSession(make("a.1.5x.sig"), KEY, NOW)).resolves.toBeNull();
    await expect(readSession(make("a.1e99.sig"), KEY, NOW)).resolves.toBeNull();
    await expect(
      readSession(new Request("https://x.test/"), KEY, NOW)
    ).resolves.toBeNull();
  });

  it("sets the attributes of a host cookie", async () => {
    const cookie = await sessionCookie(ID, KEY, NOW);
    expect(cookie).toContain("__Host-account=");

    for (const part of [
      "Secure",
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=2592000",
    ]) {
      expect(cookie).toContain(part);
    }

    expect(cookie).not.toContain("Domain");
  });

  it("clears the cookie", () => {
    const cleared = clearSessionCookie();
    expect(cleared).toContain("__Host-account=;");
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Secure; HttpOnly; SameSite=Lax; Path=/");
  });
});
