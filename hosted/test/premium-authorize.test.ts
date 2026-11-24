/**
 * The premium server's /authorize (issue #229) in Node: the address, the code, then the consent,
 * with the library's helpers stubbed, the migration's tables in SQLite, and a `fetch` stub that
 * answers Turnstile.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import type {
  AuthRequest,
  ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accountForSignIn } from "../src/accounts/store.ts";
import { authorize } from "../src/premium/authorize.ts";
import type {
  AuthorizeEnv,
  AuthorizeHelpers,
} from "../src/premium/authorize.ts";
import { sha256Hex } from "../src/secrets.ts";
import { d1Of } from "./helpers/d1.ts";

const MIGRATION = readFileSync(
  new URL("../migrations-accounts/0001_accounts.sql", import.meta.url),
  "utf-8"
);

const PREMIUM = "https://premium.agentic-seo.org";
const QUERY = "?response_type=code&client_id=client-1&state=s";
const EMAIL = "ann@example.com";
const CODE = "123456";

const AUTH_REQUEST: AuthRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "http://127.0.0.1:4000/callback",
  scope: ["mcp"],
  state: "s",
};

const APPROVED = "http://127.0.0.1:4000/callback?code=c&state=s";
const DENIED = "http://127.0.0.1:4000/callback?error=access_denied";

const DETAILS: ConsentDescription = {
  clientId: "client-1",
  clientName: "<img src=x onerror=alert(1)>",
  redirectUri: "http://127.0.0.1:4000/callback",
  redirectHost: "127.0.0.1",
  redirectIsLoopback: true,
  scope: ["mcp"],
};

/** The library's consent and authorization helpers, as stubs that record their calls. */
const newHelpers = () => ({
  parseAuthRequest: vi.fn<AuthorizeHelpers["parseAuthRequest"]>(() =>
    Promise.resolve(AUTH_REQUEST)
  ),
  describeConsent: vi.fn<AuthorizeHelpers["describeConsent"]>(() =>
    Promise.resolve(DETAILS)
  ),
  beginConsent: vi.fn<AuthorizeHelpers["beginConsent"]>(() =>
    Promise.resolve({
      handle: "handle-1",
      headers: new Headers({
        "set-cookie": "__Host-oauth-consent-x=y; Secure",
      }),
    })
  ),
  approveConsent: vi.fn<AuthorizeHelpers["approveConsent"]>(() =>
    Promise.resolve({
      request: AUTH_REQUEST,
      headers: new Headers({ "cache-control": "no-store" }),
    })
  ),
  denyConsent: vi.fn<AuthorizeHelpers["denyConsent"]>(() =>
    Promise.resolve({
      request: AUTH_REQUEST,
      redirectTo: DENIED,
      headers: new Headers({ location: DENIED }),
    })
  ),
  completeAuthorization: vi.fn<AuthorizeHelpers["completeAuthorization"]>(() =>
    Promise.resolve({ redirectTo: APPROVED })
  ),
});

let db: DatabaseSync;
let kv: Map<string, string>;
let mails: string[];
let helpers: ReturnType<typeof newHelpers>;

const env = (): AuthorizeEnv => ({
  ACCOUNTS: d1Of(db),
  EMAIL: {
    send: (message) => {
      if ("text" in message && message.text) {
        mails.push(message.text);
      }

      return Promise.resolve({ messageId: "id" });
    },
  },
  ACCOUNTS_FROM: "premium@rivi.software",
  SIGN_IN_CODES: { limit: () => Promise.resolve({ success: true }) },
  TURNSTILE_SITE_KEY: "site-key",
  TURNSTILE_SECRET_KEY: "secret-key",
  OAUTH_KV: {
    get: (key) => Promise.resolve(kv.get(key) ?? null),
    put: (key, value) => {
      kv.set(key, value);

      return Promise.resolve();
    },
    delete: (key) => {
      kv.delete(key);

      return Promise.resolve();
    },
  },
});

const post = (fields: Record<string, string>, cookie?: string) => {
  const body = new URLSearchParams(fields).toString();

  return new Request(`${PREMIUM}/authorize${QUERY}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(body.length),
      origin: PREMIUM,
      ...(cookie ? { cookie } : null),
    },
    body,
  });
};

/** A live code for EMAIL, as sendCode keeps it. */
const keepCode = async () => {
  const now = Date.now();

  db.prepare(
    "INSERT INTO sign_in_codes (email, code_hash, attempts, expires_at, sent_at) VALUES (?, ?, 0, ?, ?)"
  ).run(EMAIL, await sha256Hex(CODE), now + 600_000, now);
};

describe("the premium server's /authorize", () => {
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(MIGRATION);
    kv = new Map();
    mails = [];
    helpers = newHelpers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ success: true, action: "sign_in" }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it("asks for an address first, with the form posting back to the same request", async () => {
    const res = await authorize(
      new Request(`${PREMIUM}/authorize${QUERY}`),
      env(),
      helpers
    );

    const page = await res.text();

    expect(res.status).toBe(200);
    expect(page).toContain('name="email"');
    expect(page).toContain(
      'action="/authorize?response_type=code&amp;client_id=client-1&amp;state=s"'
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("emails a code for the address, and asks for it", async () => {
    const res = await authorize(
      post({ step: "email", email: EMAIL, "cf-turnstile-response": "t" }),
      env(),
      helpers
    );

    const page = await res.text();

    expect(res.status).toBe(200);
    expect(page).toContain('name="code"');
    expect(page).toContain(`<span class="private">${EMAIL}</span>`);
    expect(mails).toHaveLength(1);
  });

  it("shows the client's name escaped on the consent page, with the redirect's host and the loopback warning", async () => {
    await keepCode();

    const res = await authorize(
      post({ step: "code", email: EMAIL, code: CODE }),
      env(),
      helpers
    );

    const page = await res.text();

    expect(res.status).toBe(200);
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(page).not.toContain("<img src=x");
    expect(
      [
        "<strong>127.0.0.1</strong>",
        "an app on your computer",
        'name="handle" value="handle-1"',
      ].map((text) => page.includes(text))
    ).toStrictEqual([true, true, true]);
    expect([
      res.headers.get("set-cookie")?.startsWith("__Host-oauth-consent-x"),
      res.headers
        .get("content-security-policy")
        ?.includes("frame-ancestors 'none'"),
    ]).toStrictEqual([true, true]);
  });

  it("shows the code form again with a notice for a wrong code, and authorizes nothing", async () => {
    await keepCode();

    const res = await authorize(
      post({ step: "code", email: EMAIL, code: "654321" }),
      env(),
      helpers
    );

    const page = await res.text();

    expect(res.status).toBe(400);
    expect(page).toContain('name="code"');
    expect(page).toContain("That code is not right");
    expect(helpers.beginConsent).not.toHaveBeenCalled();
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("completes the authorization for the signed-in account on Allow, with its id alone in the props", async () => {
    await keepCode();
    await authorize(
      post({ step: "code", email: EMAIL, code: CODE }),
      env(),
      helpers
    );

    const account = await accountForSignIn(d1Of(db), EMAIL, Date.now());

    const res = await authorize(
      post({ step: "consent", handle: "handle-1", decision: "approve" }),
      env(),
      helpers
    );

    expect([res.status, res.headers.get("location")]).toStrictEqual([
      302,
      APPROVED,
    ]);
    expect(helpers.approveConsent).toHaveBeenCalledWith(
      expect.any(Request),
      "handle-1",
      { scope: ["mcp"] }
    );
    expect(helpers.completeAuthorization).toHaveBeenCalledWith({
      request: AUTH_REQUEST,
      userId: account.id,
      metadata: {},
      scope: ["mcp"],
      props: { accountId: account.id },
    });
    // The sign-in works once.
    expect(kv.size).toBe(0);
  });

  it("refuses Allow for a consent no code signed in", async () => {
    const res = await authorize(
      post({ step: "consent", handle: "handle-x", decision: "approve" }),
      env(),
      helpers
    );

    expect(res.status).toBe(400);
    await expect(res.text()).resolves.toContain("Start again");
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("sends the client its refusal on Deny", async () => {
    const res = await authorize(
      post({ step: "consent", handle: "handle-1", decision: "deny" }),
      env(),
      helpers
    );

    expect([res.status, res.headers.get("location")]).toStrictEqual([
      302,
      DENIED,
    ]);
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("redirects an error to the client only when its redirect was validated, and shows it otherwise", async () => {
    helpers.parseAuthRequest.mockRejectedValueOnce(
      new AuthorizationError("invalid_scope", {
        description: "bad scope",
        redirectUri: "http://127.0.0.1:4000/callback",
        state: "s",
      })
    );

    const redirected = await authorize(
      new Request(`${PREMIUM}/authorize${QUERY}`),
      env(),
      helpers
    );

    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toContain("error=invalid_scope");

    helpers.parseAuthRequest.mockRejectedValueOnce(
      new AuthorizationError("invalid_request", {
        description: "Invalid redirect URI",
      })
    );

    const shown = await authorize(
      new Request(`${PREMIUM}/authorize${QUERY}`),
      env(),
      helpers
    );

    expect(shown.status).toBe(400);
    expect(shown.headers.get("location")).toBeNull();
    await expect(shown.text()).resolves.toContain("Invalid redirect URI");
  });

  it("refuses a form from another site", async () => {
    const res = await authorize(
      new Request(`${PREMIUM}/authorize${QUERY}`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
      env(),
      helpers
    );

    await res.text();

    expect(res.status).toBe(403);
  });
});
