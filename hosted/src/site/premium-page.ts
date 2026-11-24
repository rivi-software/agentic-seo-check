/**
 * The page at /premium (issue #232): what a premium tier of the hosted server would add (issue
 * #229), the waitlist's form, and the pages its email's links open. Today's tools stay free; the
 * waitlist asks what people would pay for, and what they would pay.
 */
import { PRODUCT_NAME } from "../../../src/brand.js";
import { PRIVACY_URL } from "../ui/frame.js";
import { icon } from "../ui/icons.js";
import type { IconName } from "../ui/icons.js";
import { esc } from "./html.js";
import { HOSTED_PAGE, layout } from "./layout.js";
import {
  CONSENT_TEXT,
  FEATURES,
  PRICES,
  ROLES,
  UNCONFIRMED_DAYS,
} from "./waitlist.js";
import type {
  FeatureId,
  PremiumView,
  WaitlistEvent,
  WaitlistValues,
} from "./waitlist.js";

export const PREMIUM_PATH = "/premium";

/** The form's look, on this page alone rather than in the stylesheet every page carries. */
const WAITLIST_STYLE = `
.wl-form{display:grid;gap:14px;padding:24px;border:1px solid var(--line-strong);border-radius:16px;background:linear-gradient(180deg,#ffffff0b,#ffffff03);box-shadow:var(--shadow-panel)}
.wl-form .notice{margin-top:0}
.wl-form .btn-lg{justify-self:start}
.wl-label{color:var(--text);font-size:.9375rem;font-weight:500}
.wl-set{display:grid;gap:10px;min-width:0;margin:0;padding:0;border:0}
.wl-set legend{margin-bottom:10px;padding:0}
.wl-features{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.wl-feature{position:relative;display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);cursor:pointer;transition:border-color .16s,background-color .16s}
.wl-feature:has(input:checked){border-color:#3be08a80;background:var(--signal-soft)}
.wl-feature:has(input:focus-visible),.wl-choice:has(input:focus-visible){outline:2px solid var(--signal);outline-offset:2px}
.wl-feature>span:last-child{display:grid;gap:2px;font-size:.8125rem;line-height:1.45;color:var(--text-muted)}
.wl-feature strong{color:var(--text);font-size:.875rem;font-weight:500}
.wl-feature-icon .icon{width:18px;height:18px;margin-top:2px;color:var(--text-faint)}
.wl-feature input,.wl-choice input{position:absolute;opacity:0;pointer-events:none}
.wl-choices{display:flex;flex-wrap:wrap;gap:8px}
.wl-choice{position:relative;display:inline-flex;align-items:center;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:var(--radius-btn);background:var(--bg);color:var(--text-body);font-size:.875rem;cursor:pointer;transition:border-color .16s,background-color .16s}
.wl-choice:has(input:checked){border-color:#3be08a80;background:var(--signal-soft);color:var(--text)}
.wl-consent{display:flex;align-items:flex-start;gap:10px;font-size:.8125rem;line-height:1.5;color:var(--text-muted)}
.wl-consent input{margin-top:3px;accent-color:var(--signal)}
.wl-free{display:grid;gap:8px;margin:16px 0;padding:0;list-style:none}
.wl-free li{display:flex;align-items:flex-start;gap:10px}
.wl-free .icon{width:16px;height:16px;margin-top:4px;color:var(--signal)}
@media (max-width:720px){.wl-features{grid-template-columns:minmax(0,1fr)}.wl-form{padding:16px}}
`.replaceAll("\n", "");

const FEATURE_ICONS: Record<FeatureId, IconName> = {
  render: "cpu",
  lab: "chart",
  crawls: "layers",
  "search-console": "search",
  bing: "globe",
  watch: "clock",
};

/** What stays free whatever the premium tier becomes. */
const FREE = [
  "Every tool of the hosted MCP server, with today's limits",
  "The audit and the crawl on this website",
  "Sharing a report as a link",
  "The CLI and the local MCP server, rendering and Lighthouse included",
];

export interface PremiumState {
  page: PremiumView;
  /** The form takes signups (waitlistOpen). */
  open: boolean;
  siteKey: string;
}

const checked = (on: boolean): string => (on ? " checked" : "");

const choice = (
  name: string,
  options: readonly { id: string; label: string }[],
  picked: string | undefined
): string =>
  options
    .map(
      (option) =>
        `<label class="wl-choice"><input type="radio" name="${name}" value="${option.id}" required${checked(option.id === picked)}><span>${esc(option.label)}</span></label>`
    )
    .join("");

/** The waitlist's form, with what was typed and what was wrong with it. */
const form = (
  state: PremiumState,
  error: string | undefined,
  values: WaitlistValues | undefined
): string => {
  if (!state.open) {
    return `<p class="notice" role="status">${icon("info")}<span>The waitlist is closed at the moment. Come back soon.</span></p>`;
  }

  const features = new Set(values?.features);

  return `<form class="wl-form" method="post" action="${PREMIUM_PATH}" id="waitlist">
${error ? `<p class="notice" role="alert">${icon("error")}<span>${esc(error)}</span></p>` : ""}
<label class="wl-label" for="wl-email">Your email address</label>
<div class="audit-field">${icon("pencil")}<input id="wl-email" name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" required maxlength="254" placeholder="you@example.com" value="${esc(values?.email ?? "")}"></div>
<fieldset class="wl-set"><legend class="wl-label">What would you pay for?</legend>
<div class="wl-features">${FEATURES.map(
    (feature) =>
      `<label class="wl-feature"><input type="checkbox" name="feature" value="${feature.id}"${checked(features.has(feature.id))}><span class="wl-feature-icon">${icon(FEATURE_ICONS[feature.id])}</span><span><strong>${esc(feature.label)}</strong><span>${esc(feature.text)}</span></span></label>`
  ).join("")}</div></fieldset>
<fieldset class="wl-set"><legend class="wl-label">What would you pay a month?</legend><div class="wl-choices">${choice("price", PRICES, values?.price)}</div></fieldset>
<fieldset class="wl-set"><legend class="wl-label">Who are you?</legend><div class="wl-choices">${choice("role", ROLES, values?.role)}</div></fieldset>
<label class="wl-consent"><input type="checkbox" name="consent" value="yes" required${checked(values?.consent ?? false)}><span>${esc(CONSENT_TEXT)} <a href="${PRIVACY_URL}">Privacy policy</a></span></label>
<div class="cf-turnstile" data-sitekey="${esc(state.siteKey)}" data-action="waitlist"></div>
<button class="btn btn-primary btn-lg" type="submit">Join the waitlist${icon("arrow", "arrow")}</button>
<noscript><p class="notice">The form needs JavaScript for the check that keeps bots out.</p></noscript>
</form>`;
};

/** An event for site.js to send once the page shows: its name and properties, never the address. */
const eventMarker = (name: string, event?: WaitlistEvent): string =>
  `<div hidden data-waitlist-event="${name}" data-waitlist-props="${esc(JSON.stringify(event ?? {}))}"></div>`;

/** A page that answers a step: a heading, a line, and what to do next. */
const answer = (title: string, text: string, extra = ""): string =>
  `<section class="hero hero-glow" aria-labelledby="wl-title">
<div class="wrap">
<div class="hero-copy">
<p class="kicker">Premium waitlist</p>
<h1 id="wl-title">${title}</h1>
<p class="lede">${text}</p>
${extra}
</div>
</div>
</section>`;

/** The button a link's page asks to be pressed: a scanner that opens the link presses nothing. */
const linkButton = (action: "confirm" | "remove", token: string): string =>
  `<form method="post" action="${PREMIUM_PATH}/${action}/${esc(token)}"><button class="btn btn-primary btn-lg" type="submit">${action === "confirm" ? "Confirm my address" : "Take me off the list"}${icon("arrow", "arrow")}</button></form>`;

const BACK = `<div class="cta-actions"><a class="btn btn-secondary" href="/">Audit a page</a><a class="btn btn-secondary" href="${HOSTED_PAGE}">The hosted MCP server</a></div>`;

const stepBody = (page: Exclude<PremiumView, FormView>): string => {
  switch (page.view) {
    case "sent": {
      return answer(
        "Check your inbox.",
        `We sent a link to confirm your address. It works for ${UNCONFIRMED_DAYS} days; until you open it, you are not on the list. Nothing there? Look in your spam folder.`,
        `${page.event ? eventMarker("waitlist_signed_up", page.event) : ""}${BACK}`
      );
    }

    case "confirm": {
      return answer(
        "Confirm your address.",
        "Press the button to join the waitlist. We email you once when the premium tier opens.",
        linkButton("confirm", page.token)
      );
    }

    case "remove": {
      return answer(
        "Leave the waitlist?",
        "Press the button and your address and answers are deleted.",
        linkButton("remove", page.token)
      );
    }

    case "confirmed": {
      return answer(
        "You are on the list.",
        "Thank you. We email you once when the premium tier opens. Every email has a link that takes you off the list.",
        `${page.first ? eventMarker("waitlist_confirmed") : ""}${BACK}`
      );
    }

    case "removed": {
      return answer(
        "You are off the list.",
        "Your address and answers are deleted. The free tools stay as they are.",
        `${eventMarker("waitlist_removed")}${BACK}`
      );
    }

    case "expired": {
      return answer(
        "This link no longer works.",
        `A link to confirm an address works for ${UNCONFIRMED_DAYS} days, and each new email replaces the link before it. Sign up again to get a new one.`,
        `<div class="cta-actions"><a class="btn btn-primary" href="${PREMIUM_PATH}">Join the waitlist${icon("arrow", "arrow")}</a></div>`
      );
    }

    default: {
      return "";
    }
  }
};

/** The page with the form: what premium would add, what stays free, and the waitlist. */
type FormView = Extract<PremiumView, { view: "form" }>;

const formBody = (
  state: PremiumState,
  { error, values }: FormView
): string => `<section class="hero hero-glow" aria-labelledby="wl-title">
<div class="wrap">
<div class="hero-copy">
<p class="pill"><span class="dot" aria-hidden="true"></span>Waitlist</p>
<h1 id="wl-title">Premium, for the audits <span class="hero-accent">the free tier cannot run.</span></h1>
<p class="lede">The hosted server stays free. A premium tier would add what costs us to run: a browser, Google's and Bing's data, bigger crawls and audits on a schedule. Tell us what you would pay for, and we email you once when it opens.</p>
</div>
</div>
</section>
<section class="section section-tight" aria-labelledby="wl-form-title">
<div class="wrap split split-top">
<div class="split-copy">
<p class="kicker">Stays free</p>
<h2 id="wl-form-title">Join the waitlist.</h2>
<p>Whatever premium becomes, these stay free:</p>
<ul class="wl-free">${FREE.map((line) => `<li>${icon("check")}<span>${line}</span></li>`).join("")}</ul>
<p>We keep your address and answers in the EU, only for this, and delete them when you leave the list. An address that is not confirmed within ${UNCONFIRMED_DAYS} days is deleted.</p>
</div>
${form(state, error, values)}
</div>
</section>`;

export const premiumPage = (state: PremiumState): string => {
  const { page } = state;

  const shared = {
    path: PREMIUM_PATH,
    title: `Premium waitlist | ${PRODUCT_NAME}`,
    description: `A premium tier for ${PRODUCT_NAME}'s hosted server: JavaScript rendering, lab performance, bigger crawls, Search Console and Bing data, and watched sites. The free tools stay free. Join the waitlist.`,
    data: { "@type": "WebPage", name: "Premium waitlist" },
  };

  return page.view === "form"
    ? layout({
        ...shared,
        body: formBody(state, page),
        turnstile: state.open,
        style: WAITLIST_STYLE,
      })
    : layout({ ...shared, body: stepBody(page), noindex: true });
};
