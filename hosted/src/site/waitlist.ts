/**
 * The premium waitlist (issue #232): the form at /premium, the address it confirms by email (double
 * opt-in), and the links in that email that confirm it or take it off the list. The addresses are
 * kept in the D1 database `WAITLIST` in the EU (migrations/0001_waitlist.sql), the emails go out
 * through Cloudflare Email Service (`EMAIL`). The secret in a link is kept only as its hash, and
 * its page asks for a press of a button, since mail scanners open every link in a message.
 */
import { PRODUCT_NAME } from "../../../src/brand.js";
import { reportError } from "../analytics.js";
import type { AnalyticsEnv } from "../analytics.js";
import { callerOf } from "../callers.js";
import type { D1Like, D1Statement } from "../d1.js";
import { SITE_ORIGIN } from "../limits.js";
import { randomSecret, sha256Hex } from "../secrets.js";
import { field, fromThisSite, personSent, readForm } from "./forms.js";
import type { TurnstileEnv } from "./forms.js";

/** The waitlist's names for the D1 subset in src/d1.ts. */
export type WaitlistStatement = D1Statement;

export type WaitlistDatabase = D1Like;

export interface WaitlistEnv {
  /** The waitlist's D1 database, in the EU; without it the form is off. */
  WAITLIST?: WaitlistDatabase;
  /** Cloudflare Email Service; without it the form is off, as nothing could be confirmed. */
  EMAIL?: Pick<SendEmail, "send">;
  /** The address the emails come from, on a domain onboarded to Email Service. */
  WAITLIST_FROM?: string;
  /** Signups one IP address may send a minute. */
  WAITLIST_SIGNUPS: RateLimit;
}

/** What the premium tier would add (issue #229), as the form offers them. */
export const FEATURES = [
  {
    id: "render",
    label: "JavaScript rendering",
    text: "Audit single-page apps as a browser sees them.",
  },
  {
    id: "lab",
    label: "Lab performance",
    text: "Lighthouse scores and diagnostics, from PageSpeed Insights.",
  },
  {
    id: "crawls",
    label: "Bigger crawls",
    text: "Up to 1,000 pages, run in the background.",
  },
  {
    id: "search-console",
    label: "Google Search Console",
    text: "Findings ordered by clicks, and Google's index status.",
  },
  {
    id: "bing",
    label: "Bing Webmaster Tools",
    text: "Bing's clicks and crawl issues; Bing feeds Copilot.",
  },
  {
    id: "watch",
    label: "Watched sites",
    text: "An audit every day or week that says what regressed.",
  },
] as const;

export const PRICES = [
  { id: "under-10", label: "Under $10" },
  { id: "10-29", label: "$10 to $29" },
  { id: "30-99", label: "$30 to $99" },
  { id: "100-plus", label: "$100 or more" },
  { id: "none", label: "I would not pay yet" },
] as const;

export const ROLES = [
  { id: "solo", label: "Solo developer" },
  { id: "agency", label: "Agency or freelancer" },
  { id: "in-house", label: "In-house team" },
  { id: "other", label: "Something else" },
] as const;

export type FeatureId = (typeof FEATURES)[number]["id"];

type PriceId = (typeof PRICES)[number]["id"];

type RoleId = (typeof ROLES)[number]["id"];

/** What the consent box says; a change to it takes a new version, which each row keeps. */
export const CONSENT_TEXT =
  "Email me a link to confirm this address now, and a note when the premium tier opens. Nothing else, and every email has a link that takes me off the list.";

const CONSENT_VERSION = "2026-11-24";

/** How long an unconfirmed address is kept, and its link works. */
export const UNCONFIRMED_DAYS = 7;

const UNCONFIRMED_MS = UNCONFIRMED_DAYS * 24 * 60 * 60 * 1000;

/** The time before the form sends another email to an address, so it cannot flood one. */
export const RESEND_AFTER_MS = 10 * 60 * 1000;

/** RFC 5321's limit on an address. */
const MAX_EMAIL_CHARS = 254;

/**
 * An address in the form `local@domain.tld`, with no space and one @. Each part's class excludes
 * the character after it, so the match never backtracks; the length is capped before it runs.
 */
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;

/** The secret of a link: 32 random bytes, base64url, 43 characters. */
export const TOKEN = /^[\w-]{43}$/u;

/** The answers the form was sent with, as a person typed them, to show again with an error. */
export interface WaitlistValues {
  email: string;
  features: FeatureId[];
  price?: PriceId;
  role?: RoleId;
  consent: boolean;
}

/** The answers the analytics get with an event: never the address. */
export interface WaitlistEvent {
  features: FeatureId[];
  price: PriceId;
  role: RoleId;
}

/** What /premium shows: the form, or what became of a signup or a link. */
export type PremiumView =
  | { view: "form"; error?: string; values?: WaitlistValues }
  | { view: "sent"; event: WaitlistEvent }
  | { view: "confirm" | "remove"; token: string }
  | { view: "confirmed"; first: boolean }
  | { view: "removed" }
  | { view: "expired" };

interface WaitlistAnswer {
  status: number;
  page: PremiumView;
}

/** The bindings the waitlist reads: its own, Turnstile's and the analytics'. */
export type WaitlistSiteEnv = WaitlistEnv & TurnstileEnv & AnalyticsEnv;

interface WaitlistBindings {
  db: WaitlistDatabase;
  mail: Pick<SendEmail, "send">;
  from: string;
}

/** The bindings a signup needs, or null while one is missing and the form is off. */
const bindingsOf = (env: WaitlistSiteEnv): WaitlistBindings | null =>
  env.WAITLIST &&
  env.EMAIL &&
  env.WAITLIST_FROM &&
  env.TURNSTILE_SITE_KEY &&
  env.TURNSTILE_SECRET_KEY
    ? { db: env.WAITLIST, mail: env.EMAIL, from: env.WAITLIST_FROM }
    : null;

/** The form takes signups when it can keep, confirm and check them. */
export const waitlistOpen = (env: WaitlistSiteEnv): boolean =>
  bindingsOf(env) !== null;

/** The address as kept: trimmed, with its domain in lower case; null when it is no address. */
export const normalEmail = (typed: string): string | null => {
  const email = typed.trim();

  if (email.length > MAX_EMAIL_CHARS || !EMAIL.test(email)) {
    return null;
  }

  const at = email.lastIndexOf("@");

  return `${email.slice(0, at)}@${email.slice(at + 1).toLowerCase()}`;
};

const oneOf = <T extends { id: string }>(
  options: readonly T[],
  value: ReturnType<FormData["get"]>
): T["id"] | undefined => options.find((option) => option.id === value)?.id;

/** The answers of the form; unknown features are dropped. */
const readValues = (form: FormData): WaitlistValues => {
  const asked = new Set(form.getAll("feature"));

  return {
    email: field(form, "email").slice(0, 320),
    features: FEATURES.flatMap((feature) =>
      asked.has(feature.id) ? [feature.id] : []
    ),
    price: oneOf(PRICES, form.get("price")),
    role: oneOf(ROLES, form.get("role")),
    consent: form.get("consent") === "yes",
  };
};

/** A signup the form may keep: the address as kept, and the answers. */
interface Signup {
  email: string;
  event: WaitlistEvent;
}

/** The signup the answers make, or what is missing or wrong in them, in words for the person. */
const checkValues = (
  values: WaitlistValues
): { signup: Signup } | { problem: string } => {
  const email = normalEmail(values.email);

  if (!email) {
    return { problem: "Enter your email address, such as you@example.com." };
  }

  if (values.features.length === 0) {
    return { problem: "Pick at least one feature you would pay for." };
  }

  if (!values.price) {
    return { problem: "Pick what you would pay a month." };
  }

  if (!values.role) {
    return { problem: "Pick who you are." };
  }

  if (!values.consent) {
    return {
      problem:
        "Tick the box, so we may email you the link that confirms your address.",
    };
  }

  return {
    signup: {
      email,
      event: {
        features: values.features,
        price: values.price,
        role: values.role,
      },
    },
  };
};

/** The hash a link's secret is kept as. */
export const tokenHash = (token: string): Promise<string> => sha256Hex(token);

const linkUrl = (action: "confirm" | "remove", token: string): string =>
  `${SITE_ORIGIN}/premium/${action}/${token}`;

/** An email the waitlist sends. */
interface WaitlistMail {
  subject: string;
  text: string;
  html: string;
}

/** One email: what to do, the link that does it, and the way off the list. */
const waitlistMail = (
  kind: "confirm" | "already",
  token: string
): WaitlistMail => {
  const remove = linkUrl("remove", token);
  const lead = `Someone, hopefully you, asked to join the waitlist for ${PRODUCT_NAME}'s premium tier with this address.`;

  const action =
    kind === "confirm"
      ? {
          subject: `Confirm your place on the ${PRODUCT_NAME} premium waitlist`,
          lead: `${lead} Open this link to confirm it within ${UNCONFIRMED_DAYS} days:`,
          link: linkUrl("confirm", token),
          after:
            "Without a confirmation the address is deleted after that, and you hear nothing more.",
        }
      : {
          subject: `You are on the ${PRODUCT_NAME} premium waitlist`,
          lead: `${lead} It is on the list already, so there is nothing to do.`,
          link: null,
          after: "We will email you once when the premium tier opens.",
        };

  const text = [
    action.lead,
    ...(action.link ? ["", action.link] : []),
    "",
    action.after,
    "",
    `To take this address off the list: ${remove}`,
    "",
    `${PRODUCT_NAME}, by RIVI Software`,
  ].join("\n");

  // Every part of it is the site's own text and addresses: nothing a visitor typed.
  const html = `<p>${action.lead}</p>${action.link ? `<p><a href="${action.link}">Confirm my address</a></p>` : ""}<p>${action.after}</p><p style="color:#666">To take this address off the list, <a href="${remove}">open this link</a>.</p><p style="color:#666">${PRODUCT_NAME}, by RIVI Software</p>`;

  return { subject: action.subject, text, html };
};

const refuse = (
  status: number,
  error: string,
  values?: WaitlistValues
): WaitlistAnswer => ({
  status,
  page: { view: "form", error, ...(values ? { values } : null) },
});

/**
 * Keeps a signup with a new link, in one statement: a new address with its answers, one waiting
 * for its confirmation with the newest answers and seven more days, one on the list with its
 * answers as they were (someone else may have typed it). Answers whether the address was on the
 * list already, or null when an email went to it less than RESEND_AFTER_MS ago and none may go now.
 */
const KEEP_SIGNUP = `INSERT INTO waitlist (email, token_hash, features, price, role, consent, created_at, sent_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (email) DO UPDATE SET
  token_hash = excluded.token_hash,
  sent_at = excluded.sent_at,
  features = iif(confirmed_at IS NULL, excluded.features, features),
  price = iif(confirmed_at IS NULL, excluded.price, price),
  role = iif(confirmed_at IS NULL, excluded.role, role),
  consent = iif(confirmed_at IS NULL, excluded.consent, consent),
  created_at = iif(confirmed_at IS NULL, excluded.created_at, created_at)
WHERE excluded.sent_at - sent_at >= ?
RETURNING confirmed_at`;

/**
 * Deletes the unconfirmed addresses whose link has run out. The website's Worker runs it each day
 * (its cron trigger, worker.ts), so an address nobody confirmed is gone within a day of its seven,
 * however quiet the waitlist is.
 */
export const purgeExpired = async (
  db: WaitlistDatabase,
  now = Date.now()
): Promise<void> => {
  await db
    .prepare(
      "DELETE FROM waitlist WHERE confirmed_at IS NULL AND created_at <= ?"
    )
    .bind(now - UNCONFIRMED_MS)
    .run();
};

/**
 * Answers the form at POST /premium. Every address it takes gets the same answer, whether it was
 * new, waiting for its confirmation or on the list already, so the form tells no one whether an
 * address is on it; the email says which.
 */
export const signUp = async (
  request: Request,
  env: WaitlistSiteEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  now = Date.now()
): Promise<WaitlistAnswer> => {
  if (!fromThisSite(request)) {
    return refuse(403, "The waitlist answers this site's own form only.");
  }

  const form = await readForm(request);

  if (!form) {
    return refuse(400, "That was not the waitlist form. Fill it in below.");
  }

  const values = readValues(form);
  const checked = checkValues(values);

  if ("problem" in checked) {
    return refuse(400, checked.problem, values);
  }

  const bindings = bindingsOf(env);

  if (!bindings) {
    return refuse(503, "The waitlist is closed at the moment.", values);
  }

  const ip = request.headers.get("cf-connecting-ip");
  const { key } = callerOf(ip, []);
  const limited = await env.WAITLIST_SIGNUPS.limit({ key });

  if (!limited.success) {
    return refuse(
      429,
      "That is a lot of signups from one address. Wait a minute and send it again.",
      values
    );
  }

  if (!(await personSent(env, form, ip, "waitlist"))) {
    return refuse(
      403,
      "The check that keeps bots out did not pass, or it ran out. Send the form again.",
      values
    );
  }

  const { db, mail, from } = bindings;
  const { email, event } = checked.signup;
  const secret = randomSecret(32);

  const kept = await db
    .prepare(KEEP_SIGNUP)
    .bind(
      email,
      await tokenHash(secret),
      JSON.stringify(event.features),
      event.price,
      event.role,
      CONSENT_VERSION,
      now,
      now,
      RESEND_AFTER_MS
    )
    .first<{ confirmed_at: number | null }>();

  // An email went to the address a moment ago: no second email, and the very same page.
  if (!kept) {
    return { status: 200, page: { view: "sent", event } };
  }

  try {
    await mail.send({
      from: { email: from, name: PRODUCT_NAME },
      to: email,
      ...waitlistMail(
        kept.confirmed_at === null ? "confirm" : "already",
        secret
      ),
    });
  } catch (error) {
    // An unconfirmed address no email reached is kept for nothing; a confirmed one stays.
    ctx.waitUntil(
      db
        .prepare(
          "DELETE FROM waitlist WHERE email = ? AND confirmed_at IS NULL"
        )
        .bind(email)
        .run()
    );

    void reportError(env, ctx, error, "website:/premium");

    return refuse(
      503,
      "The email with your link could not be sent. Try again in a few minutes.",
      values
    );
  }

  return { status: 200, page: { view: "sent", event } };
};

/** A link's secret, and that its address is confirmed or its link still works. */
const LINK_WORKS =
  "token_hash = ? AND (confirmed_at IS NOT NULL OR created_at > ?)";

/**
 * Answers a press of the button behind a link: POST /premium/confirm/<token> confirms the address,
 * POST /premium/remove/<token> deletes it, each in one statement. An unknown or expired link
 * answers 404. No check of the Origin header: the link's page sends no referrer, so a browser
 * sends `Origin: null` with its button, and the secret in the address is what no other site has.
 */
export const followLink = async (
  env: WaitlistSiteEnv,
  action: "confirm" | "remove",
  token: string,
  now = Date.now()
): Promise<WaitlistAnswer> => {
  if (!env.WAITLIST) {
    return { status: 404, page: { view: "expired" } };
  }

  const hash = await tokenHash(token);
  const expiredBefore = now - UNCONFIRMED_MS;

  if (action === "remove") {
    const removed = await env.WAITLIST.prepare(
      `DELETE FROM waitlist WHERE ${LINK_WORKS} RETURNING email`
    )
      .bind(hash, expiredBefore)
      .first<{ email: string }>();

    return removed
      ? { status: 200, page: { view: "removed" } }
      : { status: 404, page: { view: "expired" } };
  }

  const confirmed = await env.WAITLIST.prepare(
    `UPDATE waitlist SET confirmed_at = coalesce(confirmed_at, ?) WHERE ${LINK_WORKS} RETURNING confirmed_at`
  )
    .bind(now, hash, expiredBefore)
    .first<{ confirmed_at: number }>();

  return confirmed
    ? {
        status: 200,
        page: { view: "confirmed", first: confirmed.confirmed_at === now },
      }
    : { status: 404, page: { view: "expired" } };
};
