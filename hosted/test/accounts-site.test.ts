/**
 * The website's account pages and the Stripe webhook (issue #229) in Node, as the waitlist's test
 * drives its routes: the migration's own tables in SQLite, Email Service and the rate limit in
 * memory, and a `fetch` stub that answers Turnstile and Stripe and records each request.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionCookie } from "../src/accounts/session.ts";
import {
  accountById,
  accountForSignIn,
  applySubscription,
  linkCustomer,
} from "../src/accounts/store.ts";
import { accountRoute } from "../src/site/account-routes.ts";
import type { AccountSiteEnv } from "../src/site/account-routes.ts";
import { d1Of } from "./helpers/d1.ts";

const MIGRATION = readFileSync(
  new URL("../migrations-accounts/0001_accounts.sql", import.meta.url),
  "utf-8"
);

const ORIGIN = "https://agentic-seo.org";
const KEY = "test-session-key";
const WEBHOOK_SECRET = "whsec_test";
const POSTHOG = "https://posthog.test";
const PORTAL = "https://billing.stripe.com/p/session/test_1";
const CHECKOUT = "https://checkout.stripe.com/c/pay/cs_test_1";

interface StripeCall {
  method: string;
  path: string;
  form: URLSearchParams;
}

let db: DatabaseSync;
let mails: string[];
let stripeCalls: StripeCall[];
let otherCalls: string[];
let stripeStatus: number;
let turnstilePasses: boolean;
let subscriptionStatus: string;

const env = (overrides: Partial<AccountSiteEnv> = {}): AccountSiteEnv => ({
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
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE: "price_123",
  TURNSTILE_SITE_KEY: "site-key",
  TURNSTILE_SECRET_KEY: "secret-key",
  POSTHOG_HOST: POSTHOG,
  ACCOUNT_SESSION_KEY: KEY,
  ...overrides,
});

const waiting: Promise<unknown>[] = [];
const CTX = { waitUntil: (promise: Promise<unknown>) => waiting.push(promise) };

/** Stripe's answer to each path the routes call. */
const stripeAnswer = (method: string, path: string): Response => {
  if (stripeStatus !== 200) {
    return Response.json({ error: { message: "down" } }, { status: 500 });
  }

  if (path === "/v1/checkout/sessions") {
    return Response.json({ url: CHECKOUT });
  }

  if (path === "/v1/billing_portal/sessions") {
    return Response.json({ url: PORTAL });
  }

  if (method === "GET" && path.startsWith("/v1/subscriptions/")) {
    return Response.json({
      id: "sub_1",
      customer: "cus_1",
      status: subscriptionStatus,
      metadata: {},
      items: { data: [{ current_period_end: 1_800_000_000 }] },
    });
  }

  return Response.json({ error: { message: "unknown" } }, { status: 404 });
};

const fakeFetch = async (
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> => {
  const request = new Request(input, init);
  const url = new URL(request.url);

  if (url.hostname === "challenges.cloudflare.com") {
    return Response.json({ success: turnstilePasses, action: "sign_in" });
  }

  if (url.hostname === "api.stripe.com") {
    stripeCalls.push({
      method: request.method,
      path: url.pathname,
      form: new URLSearchParams(await request.text()),
    });

    return stripeAnswer(request.method, url.pathname);
  }

  otherCalls.push(request.url);

  return new Response(null, { status: 204 });
};

/** The answer of the account routes to a request for `path`. */
const route = async (
  path: string,
  init: RequestInit = {},
  overrides: Partial<AccountSiteEnv> = {}
): Promise<Response> => {
  const answer = accountRoute(
    new Request(`${ORIGIN}${path}`, init),
    env(overrides),
    CTX,
    path
  );

  if (!answer) {
    throw new Error(`the account pages have no route at ${path}`);
  }

  const response = await answer;
  await Promise.all(waiting.splice(0));

  return response;
};

/** A form as a browser on this site sends it. */
const post = (
  fields: Record<string, string> = {},
  headers: Record<string, string> = {}
): RequestInit => {
  const body = new URLSearchParams(fields).toString();

  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(body.length),
      origin: ORIGIN,
      ...headers,
    },
    body,
  };
};

/** The Cookie header that carries a session for `accountId`. */
const cookieFor = async (accountId: string): Promise<string> => {
  const cookie = await sessionCookie(accountId, KEY, Date.now());

  return cookie.split(";")[0] ?? "";
};

/** The code in the last email. */
const lastCode = (): string =>
  /\b(?<code>\d{6})\b/u.exec(mails.at(-1) ?? "")?.groups?.code ?? "";

/** The page's HTML at `path`. */
const pageText = async (
  path: string,
  init: RequestInit = {},
  overrides: Partial<AccountSiteEnv> = {}
): Promise<string> => {
  const response = await route(path, init, overrides);

  return await response.text();
};

const signedIn = async (
  fields: Record<string, string> = {}
): Promise<RequestInit> => {
  const account = await accountForSignIn(
    d1Of(db),
    "Ada@example.com",
    Date.now()
  );

  return post(fields, { cookie: await cookieFor(account.id) });
};

const accountRow = async () => {
  const account = await accountForSignIn(
    d1Of(db),
    "Ada@example.com",
    Date.now()
  );

  return account;
};

/** Gives the account a customer and a subscription in `status`, as the webhook would. */
const subscribe = async (accountId: string, status: string) => {
  await linkCustomer(d1Of(db), accountId, "cus_1");
  await applySubscription(d1Of(db), {
    accountId,
    customerId: "cus_1",
    subscriptionId: "sub_1",
    status,
    currentPeriodEnd: 1_800_000_000,
    eventAt: 100,
  });
};

const webhook = (body: string, header: string | null): RequestInit => ({
  method: "POST",
  headers: header === null ? {} : { "stripe-signature": header },
  body,
});

const signature = (body: string, t: number, secret = WEBHOOK_SECRET): string =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

/** An event whose payload is older than the subscription Stripe holds, which the webhook reads. */
const subscriptionEvent = (): string =>
  JSON.stringify({
    type: "customer.subscription.updated",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "sub_1", customer: "cus_1", status: "past_due" } },
  });

describe("the account pages", () => {
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(MIGRATION);
    mails = [];
    stripeCalls = [];
    otherCalls = [];
    stripeStatus = 200;
    turnstilePasses = true;
    subscriptionStatus = "active";
    waiting.length = 0;
    vi.stubGlobal("fetch", fakeFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it("answers its own paths only", () => {
    expect(
      accountRoute(new Request(`${ORIGIN}/premium`), env(), CTX, "/premium")
    ).toBeNull();
    expect(
      accountRoute(new Request(`${ORIGIN}/accounts`), env(), CTX, "/accounts")
    ).toBeNull();
  });

  it("offers the sign-in form, with its Turnstile widget, to a visitor who is signed out", async () => {
    const form = await route("/account");

    expect(form.status).toBe(200);
    await expect(form.text()).resolves.toMatch(
      /action="\/account\/sign-in"[\s\S]*data-action="sign_in"/u
    );
  });

  it("emails a code and asks for it, with the address in a hidden field", async () => {
    const sent = await route(
      "/account/sign-in",
      post({ email: "Ada@Example.COM", "cf-turnstile-response": "token" })
    );

    expect(sent.status).toBe(200);
    await expect(sent.text()).resolves.toMatch(
      /action="\/account\/verify"[\s\S]*type="hidden" name="email" value="Ada@example\.com"/u
    );
    expect(lastCode()).toMatch(/^\d{6}$/u);
  });

  it("signs in with the emailed code and shows the address in a private part", async () => {
    await route(
      "/account/sign-in",
      post({ email: "Ada@Example.COM", "cf-turnstile-response": "token" })
    );

    const verified = await route(
      "/account/verify",
      post({ email: "Ada@example.com", code: lastCode() })
    );

    const cookie = verified.headers.get("set-cookie") ?? "";

    expect([verified.status, verified.headers.get("location")]).toStrictEqual([
      303,
      "/account",
    ]);
    expect(cookie).toMatch(/^__Host-account=acc_[\w-]+\.\d+\.[\w-]+;/u);

    const page = await route("/account", {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });

    expect(page.headers.get("cache-control")).toBe("private, no-store");
    await expect(page.text()).resolves.toMatch(
      /<[a-z]+ class="private"[^>]*>Ada@example\.com</u
    );
  });

  it("sends no code when the check that keeps bots out fails, or the form came from elsewhere", async () => {
    turnstilePasses = false;

    const bot = await route(
      "/account/sign-in",
      post({ email: "ada@example.com", "cf-turnstile-response": "x" })
    );

    turnstilePasses = true;

    const elsewhere = await route(
      "/account/sign-in",
      post(
        { email: "ada@example.com", "cf-turnstile-response": "x" },
        { origin: "https://evil.example" }
      )
    );

    expect([bot.status, elsewhere.status]).toStrictEqual([403, 403]);
    expect(mails).toStrictEqual([]);
  });

  it("shows the code form again with a notice for a wrong code, and sets no cookie", async () => {
    await route(
      "/account/sign-in",
      post({ email: "ada@example.com", "cf-turnstile-response": "token" })
    );

    const code = lastCode();
    const wrong = code === "000000" ? "000001" : "000000";

    const answer = await route(
      "/account/verify",
      post({ email: "ada@example.com", code: wrong })
    );

    const html = await answer.text();

    expect(answer.status).toBe(400);
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(html).toContain('action="/account/verify"');
    expect(html).toContain("That code is not right");
  });

  it("sends an active account to the portal, never to a second checkout", async () => {
    const account = await accountRow();
    await subscribe(account.id, "active");

    const answer = await route(
      "/account/checkout",
      post({}, { cookie: await cookieFor(account.id) })
    );

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(PORTAL);
    expect(stripeCalls.map((call) => call.path)).toStrictEqual([
      "/v1/billing_portal/sessions",
    ]);
  });

  it("sends a past_due account to the portal to fix its card, never to a second checkout", async () => {
    const account = await accountRow();
    await subscribe(account.id, "past_due");

    const cookie = await cookieFor(account.id);
    const answer = await route("/account/checkout", post({}, { cookie }));
    const page = await pageText("/account", { headers: { cookie } });

    expect(answer.headers.get("location")).toBe(PORTAL);
    expect(page).not.toContain('action="/account/checkout"');
    expect(page).toContain('action="/account/portal"');
  });

  it("sends a free account to Stripe Checkout for its own id", async () => {
    const init = await signedIn();
    const answer = await route("/account/checkout", init);

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(CHECKOUT);
    expect(stripeCalls[0]?.form.get("client_reference_id")).toMatch(/^acc_/u);
  });

  it("sends a visitor who is signed out back to the sign-in form, without asking Stripe", async () => {
    const answer = await route("/account/checkout", post());

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/account");
    expect(stripeCalls).toStrictEqual([]);
  });

  it("keeps the account and says so when Stripe cannot cancel its subscription", async () => {
    const account = await accountRow();
    await subscribe(account.id, "active");
    stripeStatus = 500;

    const answer = await route(
      "/account/delete",
      post({ confirm: "yes" }, { cookie: await cookieFor(account.id) })
    );

    const html = await answer.text();

    expect(answer.status).toBe(503);
    expect(html).toContain("Payments are unavailable right now");
    expect(answer.headers.get("set-cookie")).toBeNull();
    await expect(accountById(d1Of(db), account.id)).resolves.not.toBeNull();
  });

  it("deletes a free account, ends the session and says it is gone", async () => {
    const account = await accountRow();

    const answer = await route(
      "/account/delete",
      post({ confirm: "yes" }, { cookie: await cookieFor(account.id) })
    );

    expect(answer.status).toBe(200);
    await expect(answer.text()).resolves.toContain("Your account is deleted");
    expect(answer.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(stripeCalls).toStrictEqual([]);
    await expect(accountById(d1Of(db), account.id)).resolves.toBeNull();
  });

  it("deletes nothing without the box ticked, or from another site", async () => {
    const account = await accountRow();
    const cookie = await cookieFor(account.id);

    const unticked = await route("/account/delete", post({}, { cookie }));

    const elsewhere = await route(
      "/account/delete",
      post({ confirm: "yes" }, { cookie, origin: "https://evil.example" })
    );

    expect([unticked.status, elsewhere.status]).toStrictEqual([400, 403]);
    await expect(accountById(d1Of(db), account.id)).resolves.not.toBeNull();
  });

  it("signs out", async () => {
    const answer = await route("/account/sign-out", await signedIn());

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/account");
    expect(answer.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("says payments are unavailable, with no Subscribe button, without Stripe's key", async () => {
    const init = await signedIn();

    const answer = await route(
      "/account",
      { headers: init.headers ?? {} },
      { STRIPE_SECRET_KEY: undefined }
    );

    const html = await answer.text();

    expect(html).toContain("Payments are unavailable");
    expect(html).not.toContain('action="/account/checkout"');
  });

  it("says when payments are in test mode, and links link.com and the privacy policy", async () => {
    const init = await signedIn();

    const test = await pageText("/account", { headers: init.headers ?? {} });

    const live = await pageText(
      "/account",
      { headers: init.headers ?? {} },
      { STRIPE_SECRET_KEY: "sk_live_123" }
    );

    expect(test).toContain("Payments are in test mode. No card is charged.");
    expect(test).toContain('action="/account/checkout"');
    expect(test).toContain('href="https://link.com"');
    expect(test).toContain("privacy-policy");
    expect(live).not.toContain("test mode");
  });

  it("lets its forms send to Stripe and sends this site's origin with them", async () => {
    const answer = await route("/account");
    const csp = answer.headers.get("content-security-policy") ?? "";

    expect(csp).toContain(
      "form-action 'self' https://checkout.stripe.com https://billing.stripe.com"
    );
    // A page with no referrer makes the browser send `Origin: null`, which fromThisSite refuses.
    expect(answer.headers.get("referrer-policy")).not.toBe("no-referrer");
  });

  it("offers no sign-in without the session key, and sends no code", async () => {
    const page = await route(
      "/account",
      {},
      { ACCOUNT_SESSION_KEY: undefined }
    );

    const sent = await route(
      "/account/sign-in",
      post({ email: "ada@example.com", "cf-turnstile-response": "token" }),
      { ACCOUNT_SESSION_KEY: undefined }
    );

    await expect(page.text()).resolves.not.toContain(
      'action="/account/sign-in"'
    );
    expect(sent.status).toBe(503);
    expect(mails).toStrictEqual([]);
  });

  it("takes only the methods each path answers", async () => {
    const get = await route("/account/checkout");
    const put = await route("/account", { method: "PUT" });

    expect([get.status, put.status]).toStrictEqual([405, 405]);
  });
});

describe("the Stripe webhook", () => {
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(MIGRATION);
    mails = [];
    stripeCalls = [];
    otherCalls = [];
    stripeStatus = 200;
    subscriptionStatus = "active";
    waiting.length = 0;
    vi.stubGlobal("fetch", fakeFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it("answers 400 to a bad signature, and reports nothing", async () => {
    const body = subscriptionEvent();
    const now = Math.floor(Date.now() / 1000);

    const bad = await route(
      "/api/stripe",
      webhook(body, signature(body, now, "whsec_other"))
    );

    const missing = await route("/api/stripe", webhook(body, null));

    expect([bad.status, missing.status]).toStrictEqual([400, 400]);
    expect(stripeCalls).toStrictEqual([]);
    expect(otherCalls).toStrictEqual([]);
  });

  it("writes a subscription event to the account", async () => {
    const account = await accountRow();
    await linkCustomer(d1Of(db), account.id, "cus_1");

    const body = subscriptionEvent();

    const answer = await route(
      "/api/stripe",
      webhook(body, signature(body, Math.floor(Date.now() / 1000)))
    );

    expect(answer.status).toBe(200);
    await expect(accountById(d1Of(db), account.id)).resolves.toMatchObject({
      subscriptionId: "sub_1",
      subscriptionStatus: "active",
      currentPeriodEnd: 1_800_000_000,
    });
  });

  it("answers 503 when Stripe cannot be read, so Stripe sends the event again", async () => {
    stripeStatus = 500;

    const body = subscriptionEvent();

    const answer = await route(
      "/api/stripe",
      webhook(body, signature(body, Math.floor(Date.now() / 1000)))
    );

    expect(answer.status).toBe(503);
    expect(otherCalls).toStrictEqual([]);
  });

  it("takes POST only", async () => {
    const answer = await route("/api/stripe");

    expect(answer.status).toBe(405);
  });
});
