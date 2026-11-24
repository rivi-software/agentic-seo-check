/**
 * The account pages at /account (issue #229): the sign-in by an emailed code, the account with its
 * subscription, and the page after a deletion. An address only ever shows inside a `.private`
 * part, which a session recording masks (PRIVATE in analytics-script.ts).
 */
import { PRODUCT_NAME } from "../../../src/brand.js";
import type { Account } from "../accounts/store.js";
import { PRIVACY_URL } from "../ui/frame.js";
import { icon } from "../ui/icons.js";
import { esc } from "./html.js";
import { layout } from "./layout.js";

export const ACCOUNT_PATH = "/account";

/** Where Stripe's Link lets a customer of Managed Payments manage what they bought. */
const LINK_URL = "https://link.com";

/** The statuses of a subscription that is paid for now. */
const SUBSCRIBED = new Set(["active", "trialing"]);

/** The statuses of a subscription Stripe has ended for good, after which a new one may start. */
const ENDED = new Set(["canceled", "incomplete_expired"]);

/**
 * Whether Subscribe may start a subscription: only without a live one, since Checkout would start
 * a second beside it. A live one that is not paid (past_due, unpaid) is fixed in the portal.
 */
export const mayCheckout = (account: Account): boolean =>
  account.subscriptionStatus === null || ENDED.has(account.subscriptionStatus);

export type AccountView =
  | { view: "sign-in"; error?: string; email?: string }
  | { view: "code"; email: string; error?: string }
  | { view: "account"; account: Account; error?: string }
  | { view: "deleted" };

export interface AccountPageState {
  page: AccountView;
  /** Sign-in works: the session key, the mail and Turnstile are set up. */
  open: boolean;
  /** Stripe is set up (billingOpen): the page offers Subscribe. */
  billing: boolean;
  /** Stripe's key is a test key: nobody pays real money. */
  testMode: boolean;
  siteKey: string;
}

/** The look of the account's panels, on these pages and the premium server's sign-in (src/premium/). */
export const ACCOUNT_STYLE = `
.acc-panel{display:grid;gap:14px;max-width:640px;padding:24px;border:1px solid var(--line-strong);border-radius:16px;background:linear-gradient(180deg,#ffffff0b,#ffffff03);box-shadow:var(--shadow-panel)}
.acc-panel+.acc-panel{margin-top:16px}
.acc-panel h2{margin:0}
.acc-panel p{margin:0}
.acc-panel .notice{margin-top:0}
.acc-panel .btn-lg{justify-self:start}
.acc-label{color:var(--text);font-size:.9375rem;font-weight:500}
.acc-actions{display:flex;flex-wrap:wrap;gap:8px}
.acc-confirm{display:flex;align-items:flex-start;gap:10px;font-size:.875rem;line-height:1.5;color:var(--text-muted)}
.acc-confirm input{margin-top:3px;accent-color:var(--signal)}
.acc-status{color:var(--text)}
@media (max-width:720px){.acc-panel{padding:16px}}
`.replaceAll("\n", "");

export const alert = (error: string | undefined): string =>
  error
    ? `<p class="notice" role="alert">${icon("error")}<span>${esc(error)}</span></p>`
    : "";

export const info = (text: string): string =>
  `<p class="notice" role="status">${icon("info")}<span>${text}</span></p>`;

/** An address, in the part a session recording masks. */
export const address = (email: string): string =>
  `<span class="private">${esc(email)}</span>`;

export const hero = (kicker: string, title: string, lede: string): string =>
  `<section class="hero hero-glow" aria-labelledby="acc-title">
<div class="wrap">
<div class="hero-copy">
<p class="kicker">${kicker}</p>
<h1 id="acc-title">${title}</h1>
<p class="lede">${lede}</p>
</div>
</div>
</section>`;

export const section = (content: string): string =>
  `<section class="section section-tight"><div class="wrap">${content}</div></section>`;

/** A button that POSTs to one of the account's paths. */
const action = (
  path: string,
  label: string,
  kind: "primary" | "secondary" = "secondary"
): string =>
  `<form method="post" action="${ACCOUNT_PATH}/${path}"><button class="btn btn-${kind}" type="submit">${label}</button></form>`;

const PRIVACY = `<p>We keep your address and your subscription's status in the EU, and nothing about the sites you audit. <a href="${PRIVACY_URL}">Privacy policy</a></p>`;

const signInForm = (
  state: AccountPageState,
  error: string | undefined,
  email: string | undefined
): string => {
  if (!state.open) {
    return `<div class="acc-panel">${info("Signing in is unavailable at the moment. Come back soon.")}</div>`;
  }

  return `<form class="acc-panel" method="post" action="${ACCOUNT_PATH}/sign-in">
${alert(error)}
<label class="acc-label" for="acc-email">Your email address</label>
<div class="audit-field">${icon("pencil")}<input id="acc-email" name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" required maxlength="254" placeholder="you@example.com" value="${esc(email ?? "")}"></div>
<div class="cf-turnstile" data-sitekey="${esc(state.siteKey)}" data-action="sign_in"></div>
<button class="btn btn-primary btn-lg" type="submit">Email me a code${icon("arrow", "arrow")}</button>
<noscript><p class="notice">The form needs JavaScript for the check that keeps bots out.</p></noscript>
${PRIVACY}
</form>`;
};

const codeForm = (email: string, error: string | undefined): string =>
  `<form class="acc-panel" method="post" action="${ACCOUNT_PATH}/verify">
${alert(error)}
<p>We sent a six digit code to ${address(email)}. It works for 10 minutes. Nothing there? Look in your spam folder.</p>
<input type="hidden" name="email" value="${esc(email)}">
<label class="acc-label" for="acc-code">Sign-in code</label>
<div class="audit-field">${icon("signature")}<input id="acc-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="123456"></div>
<button class="btn btn-primary btn-lg" type="submit">Sign in${icon("arrow", "arrow")}</button>
</form>
<p><a href="${ACCOUNT_PATH}">Use another address, or ask for a new code</a></p>`;

/** A day from Stripe's Unix seconds, as people write it. */
const day = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** The subscription in a line: what Stripe last said of it. */
const statusLine = (account: Account): string => {
  const status = account.subscriptionStatus;

  const until =
    account.currentPeriodEnd === null
      ? ""
      : ` until ${day(account.currentPeriodEnd)}`;

  switch (status) {
    case null:
    case "canceled":
    case "incomplete_expired": {
      return "No subscription. You have the free tools and limits.";
    }

    case "active": {
      return `Premium, paid${until}.`;
    }

    case "trialing": {
      return `Premium, on trial${until}.`;
    }

    case "past_due":
    case "unpaid": {
      return "Premium, with a payment that did not go through. Update your card to keep it.";
    }

    default: {
      return `Subscription ${esc(status)}.`;
    }
  }
};

const billingPanel = (state: AccountPageState, account: Account): string => {
  const subscribed = SUBSCRIBED.has(account.subscriptionStatus ?? "");
  const customer = account.stripeCustomerId !== null;
  const buttons: string[] = [];

  if (state.billing && mayCheckout(account)) {
    buttons.push(action("checkout", "Subscribe", "primary"));
  }

  if (state.billing && customer) {
    buttons.push(
      action("portal", subscribed ? "Manage subscription" : "Billing")
    );
  }

  return `<div class="acc-panel">
<h2>Subscription</h2>
${state.billing ? "" : info("Payments are unavailable at the moment. Try again later.")}
${state.billing && state.testMode ? info("Payments are in test mode. No card is charged.") : ""}
<p class="acc-status">${statusLine(account)}</p>
${buttons.length > 0 ? `<div class="acc-actions">${buttons.join("")}</div>` : ""}
<p>Stripe sells the subscription on our behalf. You can also manage it at <a href="${LINK_URL}">link.com</a>.</p>
</div>`;
};

const deletePanel = `<form class="acc-panel" method="post" action="${ACCOUNT_PATH}/delete">
<h2>Delete your account</h2>
<p>This deletes your account and your address. A subscription ends at once, and the unused part of a paid month is refunded to your card.</p>
<label class="acc-confirm"><input type="checkbox" name="confirm" value="yes" required><span>Yes, delete my account.</span></label>
<button class="btn btn-secondary" type="submit">Delete my account</button>
</form>`;

const accountBody = (
  state: AccountPageState,
  account: Account,
  error: string | undefined
): string =>
  `${hero("Account", "Your account.", `Signed in as ${address(account.email)}.`)}
${section(`${alert(error)}
${billingPanel(state, account)}
${deletePanel}
<div class="cta-actions">${action("sign-out", "Sign out")}</div>
${PRIVACY}`)}`;

const body = (state: AccountPageState): string => {
  const { page } = state;

  switch (page.view) {
    case "sign-in": {
      return `${hero("Account", "Sign in.", "Type your email address and we send you a code. No password. A first sign-in makes the account.")}
${section(signInForm(state, page.error, page.email))}`;
    }

    case "code": {
      return `${hero("Account", "Check your inbox.", "Type the code from the email to sign in.")}
${section(codeForm(page.email, page.error))}`;
    }

    case "account": {
      return accountBody(state, page.account, page.error);
    }

    default: {
      return `${hero("Account", "Your account is deleted.", "Your address and your subscription's details are gone. If you had a subscription, it has ended, and the unused part of a paid month is refunded to your card.")}
${section('<div class="cta-actions"><a class="btn btn-secondary" href="/">Audit a page</a></div>')}`;
    }
  }
};

export const accountPage = (state: AccountPageState): string =>
  layout({
    path: ACCOUNT_PATH,
    title: `Account | ${PRODUCT_NAME}`,
    description: `Sign in to your ${PRODUCT_NAME} account to manage your premium subscription.`,
    data: { "@type": "WebPage", name: "Account" },
    body: body(state),
    turnstile: state.page.view === "sign-in" && state.open,
    noindex: true,
    style: ACCOUNT_STYLE,
  });
