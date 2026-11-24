/**
 * The premium waitlist (issue #232) in Node: the form, the double opt-in and the links, against the
 * migration's own table in SQLite (node:sqlite, behind the part of D1's API the waitlist calls),
 * with Email Service and Turnstile in memory.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { premiumPage } from "../src/site/premium-page.ts";
import { waitlistRoute } from "../src/site/waitlist-routes.ts";
import {
  followLink,
  normalEmail,
  RESEND_AFTER_MS,
  signUp,
  tokenHash,
  UNCONFIRMED_DAYS,
} from "../src/site/waitlist.ts";
import type {
  WaitlistDatabase,
  WaitlistSiteEnv,
  WaitlistStatement,
} from "../src/site/waitlist.ts";

const MIGRATION = readFileSync(
  new URL("../migrations/0001_waitlist.sql", import.meta.url),
  "utf-8"
);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 24, 12);
const ORIGIN = "https://agentic-seo.org";

/** D1's prepare, bind, run and first, over SQLite. */
const d1Of = (db: DatabaseSync): WaitlistDatabase => ({
  prepare: (sql) => {
    let args: SQLInputValue[] = [];

    const statement: WaitlistStatement = {
      bind: (...values) => {
        args = values;

        return statement;
      },
      run: () => {
        db.prepare(sql).run(...args);

        return Promise.resolve({ success: true });
      },
      first: <T>() =>
        // SAFETY: each query names the columns of the Row its caller asks for.
        Promise.resolve((db.prepare(sql).get(...args) ?? null) as T | null),
    };

    return statement;
  },
});

interface Sent {
  to: EmailMessageBuilder["to"];
  subject: string;
  text: string;
}

let db: DatabaseSync;
let sent: Sent[];
let mailFails: boolean;
let turnstilePasses: boolean;
let limited: boolean;

const env = (): WaitlistSiteEnv => ({
  WAITLIST: d1Of(db),
  EMAIL: {
    send: (message) => {
      if (mailFails) {
        return Promise.reject(new Error("E_DELIVERY_FAILED"));
      }

      if ("subject" in message) {
        sent.push({
          to: message.to,
          subject: message.subject,
          text: message.text ?? "",
        });
      }

      return Promise.resolve({ messageId: "id" });
    },
  },
  WAITLIST_FROM: "premium@rivi.software",
  WAITLIST_SIGNUPS: {
    limit: () => Promise.resolve({ success: !limited }),
  },
  TURNSTILE_SITE_KEY: "site-key",
  TURNSTILE_SECRET_KEY: "secret-key",
  POSTHOG_HOST: "",
});

/** The answer of the waitlist's routes to a request for `path`. */
const route = async (
  path: string,
  overrides: Partial<WaitlistSiteEnv> = {},
  init: RequestInit = {}
): Promise<Response> => {
  const answer = waitlistRoute(
    new Request(`${ORIGIN}${path}`, init),
    { ...env(), ...overrides },
    CTX,
    path
  );

  if (!answer) {
    throw new Error(`the waitlist has no route at ${path}`);
  }

  return await answer;
};

const waiting: Promise<unknown>[] = [];
const CTX = { waitUntil: (promise: Promise<unknown>) => waiting.push(promise) };

/** The work a signup left for after its answer. */
const settled = () => Promise.all(waiting.splice(0));

const FORM = {
  email: "Ada@Example.COM",
  feature: ["render", "search-console"],
  price: "10-29",
  role: "agency",
  consent: "yes",
  "cf-turnstile-response": "token",
};

const formRequest = (
  fields: Record<string, string | string[]>,
  path = "/premium"
): Request => {
  const body = new URLSearchParams();

  for (const [name, value] of Object.entries(fields)) {
    for (const one of [value].flat()) {
      body.append(name, one);
    }
  }

  const text = body.toString();

  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(text.length),
      origin: ORIGIN,
    },
    body: text,
  });
};

const send = (fields: Record<string, string | string[]> = FORM, now = NOW) =>
  signUp(formRequest(fields), env(), CTX, now);

const rows = () => db.prepare("SELECT * FROM waitlist").all();

/** The secret of the link in the last email. */
const lastToken = (kind: "confirm" | "remove"): string => {
  const match = new RegExp(`/premium/${kind}/([\\w-]{43})`, "u").exec(
    sent.at(-1)?.text ?? ""
  );

  if (!match?.[1]) {
    throw new Error(`no ${kind} link in the last email`);
  }

  return match[1];
};

const follow = (action: "confirm" | "remove", token: string, now = NOW) =>
  followLink(env(), action, token, now);

describe("the premium waitlist", () => {
  beforeEach(() => {
    waiting.length = 0;
    db = new DatabaseSync(":memory:");
    db.exec(MIGRATION);
    sent = [];
    mailFails = false;
    turnstilePasses = true;
    limited = false;
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ success: turnstilePasses }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  describe("form", () => {
    it("keeps the address with its answers, unconfirmed", async () => {
      const answer = await send();

      expect(answer).toStrictEqual({
        status: 200,
        page: {
          view: "sent",
          event: {
            features: ["render", "search-console"],
            price: "10-29",
            role: "agency",
          },
        },
      });
      expect(rows()).toMatchObject([
        {
          email: "Ada@example.com",
          features: '["render","search-console"]',
          price: "10-29",
          role: "agency",
          consent: "2026-11-24",
          created_at: NOW,
          confirmed_at: null,
        },
      ]);
    });

    it("emails a link to confirm the address, and keeps its secret as a hash only", async () => {
      await send();
      const token = lastToken("confirm");
      const hash = await tokenHash(token);

      expect(sent).toMatchObject([
        { to: "Ada@example.com", subject: expect.stringContaining("Confirm") },
      ]);
      expect(sent[0]?.text).toContain(`/premium/remove/${token}`);
      expect(rows()[0]?.token_hash).toBe(hash);
      expect(JSON.stringify(rows())).not.toContain(token);
    });

    it("answers a mistake with the form as it was sent, and keeps nothing", async () => {
      const answers = await Promise.all([
        send({ ...FORM, email: "not an address" }),
        send({ ...FORM, feature: [] }),
        send({ ...FORM, price: "a million" }),
        send({ ...FORM, role: "" }),
        send({ ...FORM, consent: "" }),
      ]);

      expect(answers.map(({ status }) => status)).toStrictEqual([
        400, 400, 400, 400, 400,
      ]);
      expect(answers[4]?.page).toMatchObject({
        view: "form",
        error: expect.stringContaining("Tick the box"),
        values: { email: "Ada@Example.COM", consent: false },
      });
      expect(rows()).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });

    it("drops a feature it does not offer", async () => {
      await send({ ...FORM, feature: ["render", "free-lunch"] });

      expect(rows()[0]?.features).toBe('["render"]');
    });

    it("refuses a form Turnstile did not pass, one from another site, and too many from one address", async () => {
      turnstilePasses = false;
      const unchecked = await send();
      turnstilePasses = true;

      limited = true;
      const flooded = await send();
      limited = false;

      const request = formRequest(FORM);
      request.headers.set("origin", "https://elsewhere.example");
      const foreign = await signUp(request, env(), CTX, NOW);

      expect([unchecked.status, flooded.status, foreign.status]).toStrictEqual([
        403, 429, 403,
      ]);
      expect(rows()).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });

    it("sends no second email to an address within ten minutes, with the same answer", async () => {
      await send();
      const again = await send(FORM, NOW + RESEND_AFTER_MS - 1);

      expect(again).toStrictEqual({ status: 200, page: { view: "sent" } });
      expect(sent).toHaveLength(1);
    });

    it("sends a new link to an unconfirmed address later, with its newest answers", async () => {
      await send();
      const old = lastToken("confirm");

      await send(
        { ...FORM, feature: "watch", price: "100-plus" },
        NOW + RESEND_AFTER_MS
      );
      const oldLink = await follow("confirm", old);
      const newLink = await follow("confirm", lastToken("confirm"));

      expect(sent).toHaveLength(2);
      expect(oldLink.page).toStrictEqual({ view: "expired" });
      expect(newLink.page).toStrictEqual({ view: "confirmed", first: true });
      expect(rows()[0]).toMatchObject({
        features: '["watch"]',
        price: "100-plus",
      });
    });

    it("tells a confirmed address it is on the list, and keeps its answers", async () => {
      await send();
      await follow("confirm", lastToken("confirm"));

      const answer = await send(
        { ...FORM, feature: "bing", price: "none", role: "other" },
        NOW + RESEND_AFTER_MS
      );

      // The same answer as for a new address: the form says nothing of who is on the list.
      expect(answer.page.view).toBe("sent");
      expect(sent.at(-1)?.subject).toContain("You are on");
      expect(sent.at(-1)?.text).not.toContain("/premium/confirm/");
      expect(rows()[0]).toMatchObject({
        features: '["render","search-console"]',
        price: "10-29",
        role: "agency",
      });
    });

    it("keeps no new address its email did not reach, and says so", async () => {
      mailFails = true;
      const answer = await send();
      await settled();

      expect(answer.status).toBe(503);
      expect(answer.page).toMatchObject({ view: "form" });
      expect(rows()).toHaveLength(0);
    });

    it("is closed without its email", async () => {
      const answer = await signUp(
        formRequest(FORM),
        { ...env(), EMAIL: undefined },
        CTX,
        NOW
      );

      expect(answer.status).toBe(503);
      expect(rows()).toHaveLength(0);
    });
  });

  describe("links", () => {
    it("confirm an address once", async () => {
      await send();
      const token = lastToken("confirm");
      const first = await follow("confirm", token, NOW + DAY);
      const second = await follow("confirm", token, NOW + 2 * DAY);

      expect(first).toStrictEqual({
        status: 200,
        page: { view: "confirmed", first: true },
      });
      expect(second.page).toStrictEqual({ view: "confirmed", first: false });
      expect(rows()[0]?.confirmed_at).toBe(NOW + DAY);
    });

    it("remove an address and its answers, from the newest email too", async () => {
      await send();
      await follow("confirm", lastToken("confirm"));
      await send(FORM, NOW + RESEND_AFTER_MS);
      const removed = await follow("remove", lastToken("remove"));

      expect(removed.page).toStrictEqual({ view: "removed" });
      expect(rows()).toHaveLength(0);
    });

    it("stop working for an unconfirmed address after seven days, which the next signup deletes", async () => {
      await send();
      const token = lastToken("confirm");
      const later = NOW + UNCONFIRMED_DAYS * DAY;
      const expired = await follow("confirm", token, later);

      await send({ ...FORM, email: "grace@example.com" }, later);
      await settled();

      expect(expired).toStrictEqual({ status: 404, page: { view: "expired" } });
      expect(rows().map(({ email }) => email)).toStrictEqual([
        "grace@example.com",
      ]);
    });

    it("confirm from the button of a page that sends no referrer, whose browser sends Origin: null", async () => {
      await send();

      const pressed = await route(
        `/premium/confirm/${lastToken("confirm")}`,
        {},
        { method: "POST", headers: { origin: "null" } }
      );

      const html = await pressed.text();

      expect(pressed.status).toBe(200);
      expect(html).toContain("You are on the list.");
      expect(rows()[0]?.confirmed_at).toStrictEqual(expect.any(Number));
    });

    it("work again for an address that signs up again after its link ran out", async () => {
      await send();
      const later = NOW + UNCONFIRMED_DAYS * DAY;

      await send(FORM, later);

      const confirmed = await follow(
        "confirm",
        lastToken("confirm"),
        later + 1
      );

      expect(confirmed.page).toStrictEqual({ view: "confirmed", first: true });
      expect(sent).toHaveLength(2);
    });

    it("answer an unknown secret as an expired link", async () => {
      const unknown = await follow("confirm", "b".repeat(43));

      expect(unknown.status).toBe(404);
    });

    it("only show a button when opened, since mail scanners open every link", async () => {
      await send();
      const token = lastToken("confirm");

      const opened = await route(`/premium/confirm/${token}`);

      const html = await opened.text();

      expect(opened.status).toBe(200);
      expect(opened.headers.get("referrer-policy")).toBe("no-referrer");
      expect(opened.headers.get("x-robots-tag")).toBe("noindex");
      expect(html).toContain(
        `<form method="post" action="/premium/confirm/${token}">`
      );
      expect(rows()[0]?.confirmed_at).toBeNull();
    });
  });

  describe("page", () => {
    it("shows what a person typed as text", () => {
      const html = premiumPage({
        page: {
          view: "form",
          error: "Pick who you are.",
          values: {
            email: '"><script>alert(1)</script>',
            features: ["render"],
            consent: true,
          },
        },
        open: true,
        siteKey: "site-key",
      });

      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain('value="render" checked');
    });

    it("names the answers in the signup's event, never the address", () => {
      const html = premiumPage({
        page: {
          view: "sent",
          event: { features: ["watch"], price: "none", role: "solo" },
        },
        open: true,
        siteKey: "site-key",
      });

      expect(html).toContain('data-waitlist-event="waitlist_signed_up"');
      expect(html).toContain("&quot;features&quot;:[&quot;watch&quot;]");
    });

    it("says the waitlist is closed without its database", async () => {
      const page = await route("/premium", { WAITLIST: undefined });

      const html = await page.text();

      expect(html).toContain("The waitlist is closed");
    });
  });

  describe("address", () => {
    it("is kept with its domain in lower case, and refused when it is no address", () => {
      expect(
        [
          " Ada@Example.COM ",
          "ada@example",
          "a b@example.com",
          "@example.com",
          `${"a".repeat(65)}@example.com`,
          `a@${"b".repeat(250)}.com`,
        ].map(normalEmail)
      ).toStrictEqual(["Ada@example.com", null, null, null, null, null]);
    });
  });
});
