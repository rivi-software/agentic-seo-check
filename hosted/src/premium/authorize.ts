/**
 * The premium server's /authorize (issue #229), where an MCP client sends a person to sign in: the
 * address, the code from the email (accounts/codes.ts, as the website's account pages use it),
 * then whether the client may use the account. The library parsed and checked the client's request
 * (`parseAuthRequest`) and keeps it server-side through the consent (`beginConsent`); each form
 * posts back to /authorize with the client's request as its query, which every step checks again.
 */
import {
  AuthorizationError,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import { checkCode, sendCode } from "../accounts/codes.js";
import type { CodeEnv } from "../accounts/codes.js";
import { sha256Hex } from "../secrets.js";
import { field, fromThisSite, personSent, readForm } from "../site/forms.js";
import type { TurnstileEnv } from "../site/forms.js";
import { HTML, SECURITY } from "../site/respond.js";
import { normalEmail } from "../site/waitlist.js";
import { authorizePage } from "./pages.js";
import type { AuthorizeView } from "./pages.js";

/** The library's helpers this page calls, which `OAuthProvider` hands it as oauth. */
export type AuthorizeHelpers = Pick<
  OAuthHelpers,
  | "parseAuthRequest"
  | "describeConsent"
  | "beginConsent"
  | "approveConsent"
  | "denyConsent"
  | "completeAuthorization"
>;

/** What the page keeps in OAUTH_KV: which account a consent's handle belongs to. */
export interface KvLike {
  get: (key: string) => Promise<string | null>;
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

export type AuthorizeEnv = CodeEnv & TurnstileEnv & { OAUTH_KV: KvLike };

/** The one scope the premium server grants: its tools, as the account. */
export const PREMIUM_SCOPE = "mcp";

/** As long as the library keeps a consent's handle: ten minutes. */
const SIGNED_IN_SECONDS = 600;

/**
 * The site's CSP without its form-action: Allow answers with a redirect to the client, which may
 * be any origin or an app's own scheme, and browsers hold a form's redirects to form-action.
 */
const CSP = SECURITY["content-security-policy"]
  .split("; ")
  .filter((directive) => !directive.startsWith("form-action"))
  .join("; ");

/**
 * A person's own pages: never cached nor indexed, and never framed. They keep a referrer for their
 * own forms, since with none a browser sends `Origin: null`, which fromThisSite refuses.
 */
const HEADERS = {
  "content-type": HTML,
  ...SECURITY,
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex",
};

/** Sign-in works: mail carries the code and Turnstile checks the form. */
const signInOpen = (env: AuthorizeEnv): boolean =>
  Boolean(env.EMAIL) &&
  Boolean(env.ACCOUNTS_FROM) &&
  Boolean(env.TURNSTILE_SITE_KEY) &&
  Boolean(env.TURNSTILE_SECRET_KEY);

/** Where a consent's handle names its account: by the handle's hash, as the library keeps it. */
const signedInKey = async (handle: string): Promise<string> =>
  `premium-sign-in:${await sha256Hex(handle)}`;

const show = (
  request: Request,
  env: AuthorizeEnv,
  page: AuthorizeView,
  status = 200,
  extra?: Headers
): Response => {
  const headers = new Headers(extra);

  for (const [name, value] of Object.entries(HEADERS)) {
    headers.set(name, value);
  }

  const { search } = new URL(request.url);

  const body = authorizePage({
    page,
    action: `/authorize${search}`,
    siteKey: env.TURNSTILE_SITE_KEY,
  });

  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers,
  });
};

const redirect = (headers: Headers, location: string): Response => {
  headers.set("location", location);
  headers.set("cache-control", "no-store");

  return new Response(null, { status: 302, headers });
};

const askCode = async (
  request: Request,
  env: AuthorizeEnv,
  form: FormData
): Promise<Response> => {
  const email = field(form, "email");
  const ip = request.headers.get("cf-connecting-ip");

  if (!(await personSent(env, form, ip, "sign_in"))) {
    return show(
      request,
      env,
      {
        view: "email",
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
      return show(request, env, { view: "code", email: normal });
    }

    case "too_soon": {
      return show(request, env, {
        view: "code",
        email: normal,
        error:
          "We sent a code a moment ago. Use that one, or wait a minute and ask for a new one.",
      });
    }

    case "invalid_email": {
      return show(
        request,
        env,
        {
          view: "email",
          email,
          error: "That does not look like an email address.",
        },
        400
      );
    }

    case "limited": {
      return show(
        request,
        env,
        {
          view: "email",
          email,
          error:
            "That is a lot of codes from one address. Wait a minute and try again.",
        },
        429
      );
    }

    default: {
      return show(
        request,
        env,
        {
          view: "email",
          email,
          error:
            "The email with your code could not be sent. Try again in a few minutes.",
        },
        503
      );
    }
  }
};

/**
 * Checks the code, and for the right one asks whether the client may use the account. The account
 * waits beside the consent's handle, which works once, in this browser, for ten minutes: the form
 * carries the handle only, so nobody can name another account in it.
 */
const checkTyped = async (
  request: Request,
  env: AuthorizeEnv,
  oauth: AuthorizeHelpers,
  form: FormData,
  authRequest: AuthRequest
): Promise<Response> => {
  const email = field(form, "email");
  const code = field(form, "code");

  if (!/^\d{6}$/u.test(code)) {
    return show(
      request,
      env,
      { view: "code", email, error: "Type the six digits from the email." },
      400
    );
  }

  const checked = await checkCode(env, email, code, Date.now());

  if ("error" in checked) {
    return checked.error === "wrong"
      ? show(
          request,
          env,
          {
            view: "code",
            email,
            error: "That code is not right. Check the email and try again.",
          },
          400
        )
      : show(
          request,
          env,
          {
            view: "email",
            email,
            error:
              checked.error === "locked"
                ? "That code had too many wrong tries. Ask for a new one."
                : "That code has run out, or was used. Ask for a new one.",
          },
          400
        );
  }

  // Described first, as the library asks: a client it cannot look up leaves nothing in KV.
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);

  await env.OAUTH_KV.put(
    await signedInKey(consent.handle),
    checked.account.id,
    {
      expirationTtl: SIGNED_IN_SECONDS,
    }
  );

  return show(
    request,
    env,
    { view: "consent", details, handle: consent.handle },
    200,
    consent.headers
  );
};

const STARTED_OVER =
  "This sign-in ran out, was used, or was opened in another browser. Start again from your app.";

/** Allow completes the authorization for the account the code signed in; Deny tells the client so. */
const decide = async (
  request: Request,
  env: AuthorizeEnv,
  oauth: AuthorizeHelpers,
  form: FormData
): Promise<Response> => {
  const handle = field(form, "handle");

  if (!handle) {
    return show(request, env, { view: "error", message: STARTED_OVER }, 400);
  }

  const key = await signedInKey(handle);

  if (field(form, "decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);

    await env.OAUTH_KV.delete(key);

    return redirect(denied.headers, denied.redirectTo);
  }

  const accountId = await env.OAUTH_KV.get(key);

  if (accountId === null) {
    return show(request, env, { view: "error", message: STARTED_OVER }, 400);
  }

  const approved = await oauth.approveConsent(request, handle, {
    scope: [PREMIUM_SCOPE],
  });

  await env.OAUTH_KV.delete(key);

  // The props are the account's id alone: no address goes into a grant.
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: accountId,
    metadata: {},
    scope: approved.request.scope,
    props: { accountId },
  });

  return redirect(approved.headers, redirectTo);
};

const steps = async (
  request: Request,
  env: AuthorizeEnv,
  oauth: AuthorizeHelpers
): Promise<Response> => {
  const post = request.method === "POST";

  if (!(post || request.method === "GET" || request.method === "HEAD")) {
    return new Response("Method not allowed.\n", {
      status: 405,
      headers: { allow: "GET, HEAD, POST" },
    });
  }

  if (post && !fromThisSite(request)) {
    return show(
      request,
      env,
      { view: "error", message: "The sign-in answers its own forms only." },
      403
    );
  }

  // Every step: the client's request may have been changed between them.
  const authRequest = await oauth.parseAuthRequest(request);

  if (!signInOpen(env)) {
    return show(request, env, { view: "unavailable" }, 503);
  }

  if (!post) {
    return show(request, env, { view: "email" });
  }

  const form = await readForm(request);

  if (!form) {
    return show(
      request,
      env,
      {
        view: "email",
        error: "That was not the sign-in form. Fill it in below.",
      },
      400
    );
  }

  switch (field(form, "step")) {
    case "code": {
      return checkTyped(request, env, oauth, form, authRequest);
    }

    case "consent": {
      return decide(request, env, oauth, form);
    }

    default: {
      return askCode(request, env, form);
    }
  }
};

/**
 * /authorize, with its errors as the library's consent-page.md says: back to the client only once
 * its redirect is checked, and on this page otherwise. Anything else is a fault, and a 500.
 */
export const authorize = async (
  request: Request,
  env: AuthorizeEnv,
  oauth: AuthorizeHelpers
): Promise<Response> => {
  try {
    return await steps(request, env, oauth);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return redirect(new Headers(), error.redirectTo);
    }

    if (error instanceof AuthorizationError) {
      return show(
        request,
        env,
        { view: "error", message: error.description },
        400
      );
    }

    if (error instanceof CimdFetchError) {
      return show(
        request,
        env,
        { view: "error", message: "This app could not be checked." },
        400
      );
    }

    throw error;
  }
};
