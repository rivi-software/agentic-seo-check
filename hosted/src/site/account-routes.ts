/**
 * The routes of the premium accounts on the website (issue #229): /account and its forms, which
 * sign in with an emailed code, start a subscription at Stripe, open Stripe's portal, sign out and
 * delete the account, and the Stripe webhook at /api/stripe. Apart from routes.ts, so that they
 * load in Node for their tests.
 */
import { checkCode, sendCode } from "../accounts/codes.js";
import type { CodeEnv } from "../accounts/codes.js";
import {
  clearSessionCookie,
  readSession,
  sessionCookie,
} from "../accounts/session.js";
import { accountById, deleteAccount } from "../accounts/store.js";
import type { Account } from "../accounts/store.js";
import {
  applyStripeEvent,
  BillingUnavailableError,
  billingOpen,
  cancelAndRefund,
  checkoutUrl,
  portalUrl,
  verifyStripeSignature,
} from "../accounts/stripe.js";
import type { StripeEnv } from "../accounts/stripe.js";
import type { AnalyticsEnv } from "../analytics.js";
import { ACCOUNT_PATH, accountPage, mayCheckout } from "./account-page.js";
import type { AccountView } from "./account-page.js";
import { field, fromThisSite, personSent, readForm } from "./forms.js";
import type { TurnstileEnv } from "./forms.js";
import { HTML, methodNotAllowed, SECURITY } from "./respond.js";
import { normalEmail } from "./waitlist.js";

export type AccountSiteEnv = CodeEnv &
  StripeEnv &
  TurnstileEnv &
  AnalyticsEnv & {
    /** Signs the session cookie, a Worker secret. Without it nobody can sign in. */
    ACCOUNT_SESSION_KEY?: string;
  };

export const STRIPE_WEBHOOK_PATH = "/api/stripe";

/** Stripe's events are a few kilobytes; a body past this is not one of them. */
const MAX_WEBHOOK_BYTES = 524_288;

/**
 * The site's CSP, with Stripe's Checkout and portal as places a form may lead: Subscribe and
 * Manage answer 303 to Stripe, and a browser holds that redirect to the page's form-action.
 */
const CSP = SECURITY["content-security-policy"].replace(
  "form-action 'self'",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com"
);

/**
 * The account pages are a person's own: never cached nor indexed. They keep a referrer for this
 * site's own requests, unlike a secret page: with none, a browser sends a form with
 * `Origin: null`, which fromThisSite refuses.
 */
const HEADERS = {
  "content-type": HTML,
  ...SECURITY,
  "content-security-policy": CSP,
  "referrer-policy": "same-origin",
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex",
};

const POSTS = new Set([
  "sign-in",
  "verify",
  "checkout",
  "portal",
  "delete",
  "sign-out",
]);

/** Sign-in works: a key signs the session, mail carries the code and Turnstile checks the form. */
const signInOpen = (env: AccountSiteEnv): boolean =>
  Boolean(env.ACCOUNT_SESSION_KEY) &&
  Boolean(env.EMAIL) &&
  Boolean(env.ACCOUNTS_FROM) &&
  Boolean(env.TURNSTILE_SITE_KEY) &&
  Boolean(env.TURNSTILE_SECRET_KEY);

const view = (
  request: Request,
  env: AccountSiteEnv,
  page: AccountView,
  status = 200,
  cookie?: string
): Response => {
  const headers = new Headers(HEADERS);

  if (cookie !== undefined) {
    headers.set("set-cookie", cookie);
  }

  const body = accountPage({
    page,
    open: signInOpen(env),
    billing: billingOpen(env),
    testMode: env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? false,
    siteKey: env.TURNSTILE_SITE_KEY,
  });

  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers,
  });
};

const redirect = (location: string, cookie?: string): Response => {
  const headers = new Headers({ location, "cache-control": "no-store" });

  if (cookie !== undefined) {
    headers.set("set-cookie", cookie);
  }

  return new Response(null, { status: 303, headers });
};

/** The account of the request's session, or null when signed out, or when nobody can sign in. */
const signedIn = async (
  request: Request,
  env: AccountSiteEnv
): Promise<Account | null> => {
  // readSession needs a key; without one there are no sessions.
  if (!env.ACCOUNT_SESSION_KEY) {
    return null;
  }

  const id = await readSession(request, env.ACCOUNT_SESSION_KEY, Date.now());

  return id === null ? null : await accountById(env.ACCOUNTS, id);
};

const NOT_HERE = "The account pages answer this site's own forms only.";

const signIn = async (
  request: Request,
  env: AccountSiteEnv
): Promise<Response> => {
  if (!fromThisSite(request)) {
    return view(request, env, { view: "sign-in", error: NOT_HERE }, 403);
  }

  if (!signInOpen(env)) {
    return view(request, env, { view: "sign-in" }, 503);
  }

  const form = await readForm(request);

  if (!form) {
    return view(
      request,
      env,
      {
        view: "sign-in",
        error: "That was not the sign-in form. Fill it in below.",
      },
      400
    );
  }

  const email = field(form, "email");
  const ip = request.headers.get("cf-connecting-ip");

  if (!(await personSent(env, form, ip, "sign_in"))) {
    return view(
      request,
      env,
      {
        view: "sign-in",
        email,
        error:
          "The check that keeps bots out did not pass, or it ran out. Send the form again.",
      },
      403
    );
  }

  const sent = await sendCode(env, email, ip, Date.now());
  const normal = normalEmail(email) ?? email;

  switch (sent) {
    case "sent": {
      return view(request, env, { view: "code", email: normal });
    }

    case "too_soon": {
      return view(request, env, {
        view: "code",
        email: normal,
        error:
          "We sent a code a moment ago. Use that one, or wait a minute and ask for a new one.",
      });
    }

    case "invalid_email": {
      return view(
        request,
        env,
        {
          view: "sign-in",
          email,
          error: "That does not look like an email address.",
        },
        400
      );
    }

    case "limited": {
      return view(
        request,
        env,
        {
          view: "sign-in",
          email,
          error:
            "That is a lot of codes, or of wrong tries for this email address. Try again later.",
        },
        429
      );
    }

    default: {
      return view(
        request,
        env,
        {
          view: "sign-in",
          email,
          error:
            "The email with your code could not be sent. Try again in a few minutes.",
        },
        503
      );
    }
  }
};

const verify = async (
  request: Request,
  env: AccountSiteEnv
): Promise<Response> => {
  if (!fromThisSite(request)) {
    return view(request, env, { view: "sign-in", error: NOT_HERE }, 403);
  }

  const key = env.ACCOUNT_SESSION_KEY;

  if (!(key && signInOpen(env))) {
    return view(request, env, { view: "sign-in" }, 503);
  }

  const form = await readForm(request);
  const email = form ? field(form, "email") : "";
  const code = form ? field(form, "code") : "";

  if (!/^\d{6}$/u.test(code)) {
    return view(
      request,
      env,
      { view: "code", email, error: "Type the six digits from the email." },
      400
    );
  }

  const now = Date.now();
  const checked = await checkCode(env, email, code, now);

  if ("account" in checked) {
    return redirect(
      ACCOUNT_PATH,
      await sessionCookie(checked.account.id, key, now)
    );
  }

  if (checked.error === "wrong") {
    return view(
      request,
      env,
      {
        view: "code",
        email,
        error: "That code is not right. Check the email and try again.",
      },
      400
    );
  }

  return view(
    request,
    env,
    {
      view: "sign-in",
      email,
      error:
        checked.error === "locked"
          ? "That code had too many wrong tries. Ask for a new one."
          : "That code has run out, or was used. Ask for a new one.",
    },
    400
  );
};

/** Answers a Stripe call that failed with the account's page and Stripe's notice. */
const billingFailed = (
  request: Request,
  env: AccountSiteEnv,
  account: Account,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- what a catch caught
  error: unknown,
  before = ""
): Response => {
  if (!(error instanceof BillingUnavailableError)) {
    throw error;
  }

  return view(
    request,
    env,
    { view: "account", account, error: `${before}${error.message}` },
    503
  );
};

/** Stripe's portal for an account with a customer; the account page for one without. */
const toPortal = async (
  request: Request,
  env: AccountSiteEnv,
  account: Account
): Promise<Response> => {
  if (account.stripeCustomerId === null) {
    return redirect(ACCOUNT_PATH);
  }

  try {
    return redirect(await portalUrl(env, account, new URL(request.url).origin));
  } catch (error) {
    return billingFailed(request, env, account, error);
  }
};

/** Subscribe: Checkout, unless the account has a live subscription, which the portal then answers. */
const checkout = async (
  request: Request,
  env: AccountSiteEnv,
  account: Account
): Promise<Response> => {
  if (!mayCheckout(account)) {
    return toPortal(request, env, account);
  }

  try {
    return redirect(
      await checkoutUrl(env, env.ACCOUNTS, account, new URL(request.url).origin)
    );
  } catch (error) {
    return billingFailed(request, env, account, error);
  }
};

/**
 * Ends the customer's subscriptions at Stripe first, refunding the unused paid time, then deletes
 * the row. A subscription Stripe already ended still goes through cancelAndRefund, which finishes
 * a refund an earlier try left halfway. When Stripe fails, the account stays, so a refund is never lost
 * with it.
 */
const remove = async (
  request: Request,
  env: AccountSiteEnv,
  account: Account
): Promise<Response> => {
  const form = await readForm(request);

  if (!form || field(form, "confirm") !== "yes") {
    return view(
      request,
      env,
      {
        view: "account",
        account,
        error: "Tick the box to confirm, then press Delete my account.",
      },
      400
    );
  }

  // Asked even when the row names no subscription: the customer can have one whose webhook has
  // not landed yet. An account without a customer sends Stripe nothing.
  try {
    await cancelAndRefund(env, account);
  } catch (error) {
    return billingFailed(
      request,
      env,
      account,
      error,
      "Your subscription could not be ended, so your account is kept. "
    );
  }

  await deleteAccount(env.ACCOUNTS, account.id);

  return view(request, env, { view: "deleted" }, 200, clearSessionCookie());
};

/** A form of the signed-in account: Subscribe, Manage, Delete. */
const accountAction = async (
  request: Request,
  env: AccountSiteEnv,
  name: string
): Promise<Response> => {
  const account = await signedIn(request, env);

  if (!fromThisSite(request)) {
    return view(
      request,
      env,
      account
        ? { view: "account", account, error: NOT_HERE }
        : { view: "sign-in", error: NOT_HERE },
      403
    );
  }

  if (account === null) {
    return redirect(ACCOUNT_PATH);
  }

  switch (name) {
    case "checkout": {
      return checkout(request, env, account);
    }

    case "portal": {
      return toPortal(request, env, account);
    }

    default: {
      return remove(request, env, account);
    }
  }
};

const post = (
  request: Request,
  env: AccountSiteEnv,
  name: string
): Promise<Response> => {
  switch (name) {
    case "sign-in": {
      return signIn(request, env);
    }

    case "verify": {
      return verify(request, env);
    }

    case "sign-out": {
      return Promise.resolve(
        fromThisSite(request)
          ? redirect(ACCOUNT_PATH, clearSessionCookie())
          : view(request, env, { view: "sign-in", error: NOT_HERE }, 403)
      );
    }

    default: {
      return accountAction(request, env, name);
    }
  }
};

/** The body as text, or null past `max` bytes, read without buffering more than that. */
const readCapped = async (
  request: Request,
  max: number
): Promise<string | null> => {
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a stream hands over its chunks one after another
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;

    if (size > max) {
      break;
    }

    chunks.push(value);
  }

  if (size > max) {
    await reader.cancel();

    return null;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
};

const plain = (text: string, status: number): Response =>
  new Response(`${text}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/**
 * Stripe's webhook. A bad signature answers 400 and is no error to report: anyone can send one.
 * When Stripe cannot be read back, it answers 503, so Stripe sends the event again later.
 */
const stripeWebhook = async (
  request: Request,
  env: AccountSiteEnv
): Promise<Response> => {
  const body = await readCapped(request, MAX_WEBHOOK_BYTES);

  if (body === null) {
    return plain("Too large.", 413);
  }

  const signed = await verifyStripeSignature(
    body,
    request.headers.get("stripe-signature"),
    env.STRIPE_WEBHOOK_SECRET ?? "",
    Math.floor(Date.now() / 1000)
  );

  if (!signed) {
    return plain("Bad signature.", 400);
  }

  let event: unknown;

  try {
    event = JSON.parse(body);
  } catch {
    return plain("Not JSON.", 400);
  }

  try {
    await applyStripeEvent(env, env.ACCOUNTS, event);
  } catch (error) {
    if (error instanceof BillingUnavailableError) {
      return plain("Stripe is unavailable. Send it again.", 503);
    }

    throw error;
  }

  return Response.json({ received: true });
};

/** The account routes and the Stripe webhook, or null for any other path. */
export const accountRoute = (
  request: Request,
  env: AccountSiteEnv,
  _ctx: Pick<ExecutionContext, "waitUntil">,
  pathname: string
): Promise<Response> | null => {
  const { method } = request;

  if (pathname === STRIPE_WEBHOOK_PATH) {
    return method === "POST"
      ? stripeWebhook(request, env)
      : Promise.resolve(methodNotAllowed("POST"));
  }

  if (pathname === ACCOUNT_PATH) {
    if (method !== "GET" && method !== "HEAD") {
      return Promise.resolve(methodNotAllowed("GET, HEAD"));
    }

    return signedIn(request, env).then((account) =>
      view(
        request,
        env,
        account ? { view: "account", account } : { view: "sign-in" }
      )
    );
  }

  const name = pathname.startsWith(`${ACCOUNT_PATH}/`)
    ? pathname.slice(ACCOUNT_PATH.length + 1)
    : "";

  if (!POSTS.has(name)) {
    return null;
  }

  return method === "POST"
    ? post(request, env, name)
    : Promise.resolve(methodNotAllowed("POST"));
};
