/**
 * The premium server's sign-in pages at /authorize (issue #229): the address, the code from the
 * email, then whether the MCP client may use the account. They are the website's account pages
 * in look and words (site/account-page.ts), in the MCP server's frame on the premium hostname.
 * Everything a client or a person typed goes through `esc`, and an address only ever shows inside
 * a `.private` part, which a session recording masks.
 */
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

import { PRODUCT_NAME } from "../../../src/brand.js";
import { MCP_URL, PREMIUM_ORIGIN, SITE_ORIGIN } from "../limits.js";
import {
  ACCOUNT_STYLE,
  address,
  alert,
  hero,
  info,
  section,
} from "../site/account-page.js";
import { esc } from "../site/html.js";
import { frame, PRIVACY_URL } from "../ui/frame.js";
import { icon } from "../ui/icons.js";
import { SERVER_CARD } from "../ui/og.js";

/** The premium server's pages, whose header offers the website's account page. */
const PREMIUM = {
  origin: PREMIUM_ORIGIN,
  action: { href: `${SITE_ORIGIN}/account`, label: "Your account" },
  card: SERVER_CARD,
};

export type AuthorizeView =
  | { view: "email"; email?: string; error?: string }
  | { view: "code"; email: string; error?: string }
  | { view: "consent"; details: ConsentDescription; handle: string }
  | { view: "error"; message: string }
  | { view: "unavailable" };

export interface AuthorizePageState {
  page: AuthorizeView;
  /** Where the forms post: /authorize with the client's request as its query, which each step reads again. */
  action: string;
  siteKey: string;
}

const PRIVACY = `<p>We keep your address and your subscription's status in the EU, and nothing about the sites you audit. <a href="${PRIVACY_URL}">Privacy policy</a></p>`;

const emailForm = (
  state: AuthorizePageState,
  email: string | undefined,
  error: string | undefined
): string =>
  `<form class="acc-panel" method="post" action="${esc(state.action)}">
${alert(error)}
<input type="hidden" name="step" value="email">
<label class="acc-label" for="acc-email">Your email address</label>
<div class="audit-field">${icon("pencil")}<input id="acc-email" name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" required maxlength="254" placeholder="you@example.com" value="${esc(email ?? "")}"></div>
<div class="cf-turnstile" data-sitekey="${esc(state.siteKey)}" data-action="sign_in"></div>
<button class="btn btn-primary btn-lg" type="submit">Email me a code${icon("arrow", "arrow")}</button>
<noscript><p class="notice">The form needs JavaScript for the check that keeps bots out.</p></noscript>
${PRIVACY}
</form>`;

const codeForm = (
  state: AuthorizePageState,
  email: string,
  error: string | undefined
): string =>
  `<form class="acc-panel" method="post" action="${esc(state.action)}">
${alert(error)}
<p>We sent a six digit code to ${address(email)}. It works for 10 minutes. Nothing there? Look in your spam folder.</p>
<input type="hidden" name="step" value="code">
<input type="hidden" name="email" value="${esc(email)}">
<label class="acc-label" for="acc-code">Sign-in code</label>
<div class="audit-field">${icon("signature")}<input id="acc-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="123456"></div>
<button class="btn btn-primary btn-lg" type="submit">Sign in${icon("arrow", "arrow")}</button>
</form>
<p><a href="${esc(state.action)}">Use another address, or ask for a new code</a></p>`;

/**
 * The facts the consent page must show (the library's docs/consent-page.md): the client's name,
 * whose app it is, where access goes, and a warning when that is an app on this computer, since
 * anything there could be listening, whatever name the client gives.
 */
const consentForm = (
  state: AuthorizePageState,
  details: ConsentDescription,
  handle: string
): string => {
  const origin = details.clientDomain
    ? `Published by <strong>${esc(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not checked.";

  const loopback = details.redirectIsLoopback
    ? info(
        "<strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it."
      )
    : "";

  return `<form class="acc-panel" method="post" action="${esc(state.action)}">
<h2>Allow ${esc(details.clientName)} to use your account?</h2>
<p>${origin} Access will be sent to <strong>${esc(details.redirectHost)}</strong>.</p>
${loopback}
<p>It may call the ${PRODUCT_NAME} tools as you, with your account's limits. It sees nothing else of your account. Your subscription and the account itself are at <a href="${SITE_ORIGIN}/account">agentic-seo.org/account</a>.</p>
<input type="hidden" name="step" value="consent">
<input type="hidden" name="handle" value="${esc(handle)}">
<div class="acc-actions"><button class="btn btn-primary" type="submit" name="decision" value="approve">Allow</button><button class="btn btn-secondary" type="submit" name="decision" value="deny">Deny</button></div>
</form>`;
};

const body = (state: AuthorizePageState): string => {
  const { page } = state;

  switch (page.view) {
    case "email": {
      return `${hero("Premium", "Sign in to connect.", "Type your email address and we send you a code. No password. A first sign-in makes the account.")}
${section(emailForm(state, page.email, page.error))}`;
    }

    case "code": {
      return `${hero("Premium", "Check your inbox.", "Type the code from the email to sign in.")}
${section(codeForm(state, page.email, page.error))}`;
    }

    case "consent": {
      return `${hero("Premium", "Connect your app.", "You are signed in. Say whether this app may use the premium server with your account.")}
${section(consentForm(state, page.details, page.handle))}`;
    }

    case "error": {
      return `${hero("Premium", "This sign-in cannot go on.", "Start again from your app.")}
${section(`<div class="acc-panel">${alert(page.message)}<p>Connect the premium server again from your app, which opens a new sign-in. The free server needs none: <a href="${MCP_URL}">${MCP_URL}</a>.</p></div>`)}`;
    }

    default: {
      return `${hero("Premium", "Signing in is unavailable.", "Come back soon.")}
${section(`<div class="acc-panel">${info("Signing in is unavailable at the moment. Come back soon.")}</div>`)}`;
    }
  }
};

export const authorizePage = (state: AuthorizePageState): string =>
  frame(PREMIUM, {
    path: "/authorize",
    title: `Sign in | ${PRODUCT_NAME} premium`,
    description: `Sign in to connect an app to the ${PRODUCT_NAME} premium server.`,
    data: { "@type": "WebPage", name: "Sign in" },
    body: body(state),
    turnstile: state.page.view === "email",
    noindex: true,
    style: ACCOUNT_STYLE,
  });
