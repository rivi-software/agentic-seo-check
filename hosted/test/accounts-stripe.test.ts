/**
 * Stripe (issue #229) in Node: the webhook's signature, the events it applies to the real
 * migration in SQLite, and the API calls, against a `fetch` stub that records each request.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accountById, accountForSignIn } from "../src/accounts/store.ts";
import type { Account } from "../src/accounts/store.ts";
import {
  applyStripeEvent,
  BillingUnavailableError,
  billingOpen,
  cancelAndRefund,
  checkoutUrl,
  portalUrl,
  STRIPE_VERSION,
  verifyStripeSignature,
} from "../src/accounts/stripe.ts";
import type { StripeEnv } from "../src/accounts/stripe.ts";
import { d1Of } from "./helpers/d1.ts";

const SECRET = "whsec_test";
const NOW = 1_795_000_000;
const ORIGIN = "https://agentic-seo.org";

const ENV: StripeEnv = {
  STRIPE_PRICE: "price_123",
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: SECRET,
};

const sign = (body: string, t: number, secret = SECRET): string =>
  createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

interface Sent {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  headers: Headers;
}

/** A body Stripe answers with. */
type StripeJson =
  | string
  | number
  | boolean
  | null
  | StripeJson[]
  | { [key: string]: StripeJson };

type Answer = (request: Sent) => Response;

const reply = (body: StripeJson, status = 200): Response =>
  Response.json(body, { status });

const failing =
  (status: number): Answer =>
  () =>
    reply({ error: { message: "Stripe failed" } }, status);

const empty: Answer = () => reply({});

const routesOf = (sent: Sent[]): string[] =>
  sent.map((request) => `${request.method} ${request.path}`);

const account = (fields: Partial<Account> = {}): Account => ({
  currentPeriodEnd: null,
  email: "ada@example.com",
  id: "acc_1",
  stripeCustomerId: null,
  stripeEventAt: null,
  subscriptionId: null,
  subscriptionStatus: null,
  ...fields,
});

interface EventFixture {
  type: string;
  created: number;
  data: { object: { [key: string]: StripeJson } };
}

/** An event as Stripe sends it; its payload's status may be older than the subscription's. */
const subscriptionEvent = (
  type: string,
  created: number,
  status: string
): EventFixture => ({
  created,
  data: {
    object: {
      customer: "cus_1",
      id: "sub_1",
      items: { data: [{ current_period_end: 1_700_000_000 }] },
      metadata: {},
      object: "subscription",
      status,
    },
  },
  type,
});

const checkoutEvent = (accountId: string): EventFixture => ({
  created: 50,
  data: {
    object: {
      client_reference_id: accountId,
      customer: "cus_1",
      id: "cs_1",
      object: "checkout.session",
      subscription: "sub_1",
    },
  },
  type: "checkout.session.completed",
});

/** The subscription as Stripe holds it now, which the webhook reads for each event. */
const heldSubscription = (
  status: string,
  metadata: Record<string, string>
): StripeJson => ({
  customer: "cus_1",
  id: "sub_1",
  items: { data: [{ current_period_end: 1_800_000_000 }] },
  metadata,
  object: "subscription",
  status,
});

const PAID_INVOICE = {
  amount_paid: 2000,
  currency: "eur",
  id: "in_paid",
  status: "paid",
  total: 2000,
};

const FINAL_INVOICE = {
  amount_paid: 0,
  currency: "eur",
  id: "in_final",
  status: "paid",
  total: -1500,
};

/** The customer's subscriptions as `GET /v1/subscriptions?customer=` lists them. */
const listing =
  (
    ...subscriptions: [id: string, status: string, refundInvoice?: string][]
  ): Answer =>
  () =>
    reply({
      data: subscriptions.map(([id, status, refundInvoice]): StripeJson => ({
        customer: "cus_1",
        id,
        metadata:
          refundInvoice === undefined ? {} : { refund_invoice: refundInvoice },
        status,
      })),
      has_more: false,
    });

/** Stripe as it answers an active subscription with 1500 of unused time on a 2000 payment. */
const stripeAnswers =
  (overrides: Record<string, Answer> = {}): Answer =>
  (request) => {
    const route = `${request.method} ${request.path}`;
    const override = overrides[route];

    if (override !== undefined) {
      return override(request);
    }

    switch (route) {
      case "GET /v1/subscriptions": {
        return listing(["sub_1", "active"])(request);
      }

      case "GET /v1/payment_intents/pi_1": {
        return reply({
          id: "pi_1",
          latest_charge: { amount_captured: 2000, amount_refunded: 0 },
        });
      }

      case "GET /v1/customers/cus_1/balance_transactions": {
        return reply({ data: [], has_more: false });
      }

      case "GET /v1/subscriptions/sub_1": {
        return reply({
          customer: "cus_1",
          id: "sub_1",
          latest_invoice: PAID_INVOICE,
          metadata: {},
          status: "active",
        });
      }

      case "DELETE /v1/subscriptions/sub_1": {
        return reply({
          customer: "cus_1",
          id: "sub_1",
          latest_invoice: FINAL_INVOICE,
          metadata: { refund_invoice: "in_paid" },
          status: "canceled",
        });
      }

      case "GET /v1/customers/cus_1": {
        return reply({ balance: -1500, currency: "eur", id: "cus_1" });
      }

      case "GET /v1/invoice_payments": {
        return reply({
          data: [
            {
              amount_paid: 2000,
              payment: { payment_intent: "pi_1", type: "payment_intent" },
              status: "paid",
            },
          ],
        });
      }

      case "GET /v1/refunds": {
        return reply({ data: [] });
      }

      default: {
        return reply({ id: "ok" });
      }
    }
  };

/** A request sent to `route` ("GET /v1/refunds"), the first. */
const sentTo = (all: Sent[], route: string): Sent | undefined =>
  all.find((request) => `${request.method} ${request.path}` === route);

/** Stripe's answer for an object it does not have. */
const missing: Answer = () =>
  reply(
    {
      error: {
        code: "resource_missing",
        message: "No such subscription",
        type: "invalid_request_error",
      },
    },
    404
  );

/** A past_due subscription `id`, whose latest invoice nobody paid. */
const pastDue =
  (id: string): Answer =>
  () =>
    reply({
      customer: "cus_1",
      id,
      latest_invoice: { ...PAID_INVOICE, amount_paid: 0, status: "open" },
      metadata: {},
      status: "past_due",
    });

/** A retry: the subscription is canceled already, stamped with the invoice to refund. */
const canceledEarlier: Answer = () =>
  reply({
    customer: "cus_1",
    id: "sub_1",
    latest_invoice: FINAL_INVOICE,
    metadata: { refund_invoice: "in_paid" },
    status: "canceled",
  });

/** A retry: sub_1 is canceled already, stamped with the invoice to refund. */
const retrying = (overrides: Record<string, Answer> = {}): Answer =>
  stripeAnswers({
    "GET /v1/subscriptions": listing(["sub_1", "canceled", "in_paid"]),
    "GET /v1/subscriptions/sub_1": canceledEarlier,
    ...overrides,
  });

/** A database with the real migration, as D1 runs it. */
const migrated = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");

  db.exec(
    readFileSync(
      new URL("../migrations-accounts/0001_accounts.sql", import.meta.url),
      "utf-8"
    )
  );

  return db;
};

const MINUTE_MS = 60_000;

describe("stripe", () => {
  let sent: Sent[] = [];
  let answer: Answer = empty;

  beforeEach(() => {
    sent = [];
    answer = empty;
    vi.stubGlobal(
      "fetch",
      (
        input: string | URL | Request,
        init?: RequestInit
      ): Promise<Response> => {
        const url = new URL(String(input));

        const request: Sent = {
          form: new URLSearchParams(String(init?.body ?? "")),
          headers: new Headers(init?.headers),
          method: init?.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
        };

        sent.push(request);

        return Promise.resolve(answer(request));
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe(billingOpen, () => {
    it("is open only with the key, the webhook secret and the price", () => {
      expect(billingOpen(ENV)).toBeTruthy();
      expect(billingOpen({ ...ENV, STRIPE_PRICE: "" })).toBeFalsy();
      expect(billingOpen({ ...ENV, STRIPE_SECRET_KEY: undefined })).toBeFalsy();
      expect(
        billingOpen({ ...ENV, STRIPE_WEBHOOK_SECRET: undefined })
      ).toBeFalsy();
    });
  });

  describe(verifyStripeSignature, () => {
    const body = '{"id":"evt_1","type":"customer.subscription.updated"}';

    it("accepts a header signed with the secret now", async () => {
      const header = `t=${NOW},v1=${sign(body, NOW)}`;

      await expect(
        verifyStripeSignature(body, header, SECRET, NOW)
      ).resolves.toBeTruthy();
    });

    it("refuses a body with one byte changed", async () => {
      const header = `t=${NOW},v1=${sign(body, NOW)}`;

      await expect(
        verifyStripeSignature(
          body.replace("evt_1", "evt_2"),
          header,
          SECRET,
          NOW
        )
      ).resolves.toBeFalsy();
    });

    it("refuses a signature older than five minutes", async () => {
      const t = NOW - 301;

      await expect(
        verifyStripeSignature(body, `t=${t},v1=${sign(body, t)}`, SECRET, NOW)
      ).resolves.toBeFalsy();
    });

    it("accepts the second v1 while a secret rotates", async () => {
      const header = `t=${NOW},v1=${sign(body, NOW, "whsec_old")},v1=${sign(body, NOW)}`;

      await expect(
        verifyStripeSignature(body, header, SECRET, NOW)
      ).resolves.toBeTruthy();
    });

    it("refuses a request without the header", async () => {
      await expect(
        verifyStripeSignature(body, null, SECRET, NOW)
      ).resolves.toBeFalsy();
    });

    it("refuses a header without a v1 or without a time", async () => {
      await expect(
        verifyStripeSignature(body, `t=${NOW}`, SECRET, NOW)
      ).resolves.toBeFalsy();
      await expect(
        verifyStripeSignature(body, `v1=${sign(body, NOW)}`, SECRET, NOW)
      ).resolves.toBeFalsy();
    });
  });

  describe(checkoutUrl, () => {
    let db: DatabaseSync;
    let free: Account;

    const CHECKOUT = "https://checkout.stripe.com/c/pay/cs_1";
    const PORTAL = "https://billing.stripe.com/p/session/1";

    /** Stripe for a customer with the subscriptions `listed`. */
    const checkoutAnswers =
      (listed: Answer = listing()): Answer =>
      (request) => {
        switch (`${request.method} ${request.path}`) {
          case "POST /v1/customers": {
            return reply({ id: "cus_new" });
          }

          case "GET /v1/subscriptions": {
            return listed(request);
          }

          case "POST /v1/billing_portal/sessions": {
            return reply({ url: PORTAL });
          }

          default: {
            return reply({ url: CHECKOUT });
          }
        }
      };

    beforeEach(async () => {
      db = migrated();
      free = await accountForSignIn(d1Of(db), "ada@example.com", Date.now());
      answer = checkoutAnswers();
    });

    it("makes the account's customer and links it before the first Checkout", async () => {
      await expect(checkoutUrl(ENV, d1Of(db), free, ORIGIN)).resolves.toBe(
        CHECKOUT
      );
      expect(routesOf(sent)).toStrictEqual([
        "POST /v1/customers",
        "GET /v1/subscriptions",
        "POST /v1/checkout/sessions",
      ]);

      const [customer, listed] = sent;

      expect(Object.fromEntries(customer?.form ?? [])).toStrictEqual({
        email: "ada@example.com",
        "metadata[account_id]": free.id,
      });
      expect(customer?.headers.get("Idempotency-Key")).toBe(
        `customer-${free.id}`
      );
      expect(Object.fromEntries(listed?.query ?? [])).toStrictEqual({
        customer: "cus_new",
        limit: "100",
        status: "all",
      });
    });

    it("keeps the customer it made on the account", async () => {
      await checkoutUrl(ENV, d1Of(db), free, ORIGIN);

      await expect(accountById(d1Of(db), free.id)).resolves.toMatchObject({
        stripeCustomerId: "cus_new",
      });
    });

    it("opens a Managed Payments subscription for the account's customer", async () => {
      await checkoutUrl(ENV, d1Of(db), free, ORIGIN);

      expect(Object.fromEntries(sent.at(-1)?.form ?? [])).toStrictEqual({
        cancel_url: `${ORIGIN}/account`,
        client_reference_id: free.id,
        customer: "cus_new",
        "line_items[0][price]": "price_123",
        "line_items[0][quantity]": "1",
        "managed_payments[enabled]": "true",
        mode: "subscription",
        "subscription_data[metadata][account_id]": free.id,
        success_url: `${ORIGIN}/account`,
      });
    });

    it("sends the pinned API version and the secret key", async () => {
      await checkoutUrl(ENV, d1Of(db), free, ORIGIN);

      for (const request of sent) {
        expect(request.headers.get("Stripe-Version")).toBe(STRIPE_VERSION);
        expect(request.headers.get("Authorization")).toBe("Bearer sk_test_123");
      }
    });

    it("uses the customer the account has, without making another", async () => {
      await checkoutUrl(
        ENV,
        d1Of(db),
        { ...free, stripeCustomerId: "cus_1" },
        ORIGIN
      );

      expect(routesOf(sent)).toStrictEqual([
        "GET /v1/subscriptions",
        "POST /v1/checkout/sessions",
      ]);
      expect(sent.at(-1)?.form.get("customer")).toBe("cus_1");
    });

    it("sends a customer with a subscription not ended to the portal, before the webhook says so", async () => {
      answer = checkoutAnswers(
        listing(["sub_old", "canceled"], ["sub_1", "incomplete"])
      );

      await expect(
        checkoutUrl(
          ENV,
          d1Of(db),
          { ...free, stripeCustomerId: "cus_1" },
          ORIGIN
        )
      ).resolves.toBe(PORTAL);
      expect(routesOf(sent)).not.toContain("POST /v1/checkout/sessions");
    });

    it("opens Checkout when every subscription of the customer has ended", async () => {
      answer = checkoutAnswers(
        listing(["sub_1", "canceled"], ["sub_2", "incomplete_expired"])
      );

      await expect(
        checkoutUrl(
          ENV,
          d1Of(db),
          { ...free, stripeCustomerId: "cus_1" },
          ORIGIN
        )
      ).resolves.toBe(CHECKOUT);
    });

    it("throws BillingUnavailableError when Stripe fails", async () => {
      answer = failing(500);

      await expect(
        checkoutUrl(ENV, d1Of(db), free, ORIGIN)
      ).rejects.toBeInstanceOf(BillingUnavailableError);
      await expect(accountById(d1Of(db), free.id)).resolves.toMatchObject({
        stripeCustomerId: null,
      });
    });

    it("throws BillingUnavailableError while billing is not set up", async () => {
      await expect(
        checkoutUrl({ ...ENV, STRIPE_PRICE: "" }, d1Of(db), free, ORIGIN)
      ).rejects.toBeInstanceOf(BillingUnavailableError);
      expect(sent).toHaveLength(0);
    });
  });

  describe(portalUrl, () => {
    it("opens the customer portal and comes back to the account page", async () => {
      answer = () => reply({ url: "https://billing.stripe.com/p/session/1" });

      await expect(
        portalUrl(ENV, account({ stripeCustomerId: "cus_1" }), ORIGIN)
      ).resolves.toBe("https://billing.stripe.com/p/session/1");
      expect(routesOf(sent)).toStrictEqual([
        "POST /v1/billing_portal/sessions",
      ]);
      expect(Object.fromEntries(sent[0]?.form ?? [])).toStrictEqual({
        customer: "cus_1",
        return_url: `${ORIGIN}/account`,
      });
    });
  });

  describe(applyStripeEvent, () => {
    let db: DatabaseSync;
    let id = "";
    let held: StripeJson = null;

    const row = (): Promise<Account | null> => accountById(d1Of(db), id);

    const apply = (event: StripeJson | EventFixture): Promise<string> =>
      applyStripeEvent(ENV, d1Of(db), event);

    beforeEach(async () => {
      db = migrated();

      const created = await accountForSignIn(
        d1Of(db),
        "ada@example.com",
        Date.now()
      );

      ({ id } = created);

      held = heldSubscription("active", { account_id: id });
      answer = (request) =>
        request.path === "/v1/subscriptions/sub_1"
          ? reply(held)
          : reply({ error: { message: "No such object" } }, 404);
    });

    it("links the customer when a checkout completes", async () => {
      await expect(apply(checkoutEvent(id))).resolves.toBe("applied");
      const linked = await row();

      expect(linked?.stripeCustomerId).toBe("cus_1");
      expect(sent).toHaveLength(0);
    });

    it("writes the subscription as Stripe holds it, not as the event had it", async () => {
      await expect(
        apply(
          subscriptionEvent("customer.subscription.updated", 200, "incomplete")
        )
      ).resolves.toBe("applied");
      const updated = await row();

      expect(routesOf(sent)).toStrictEqual(["GET /v1/subscriptions/sub_1"]);
      expect(sent[0]?.headers.get("Stripe-Version")).toBe(STRIPE_VERSION);
      expect(updated).toMatchObject({
        currentPeriodEnd: 1_800_000_000,
        stripeCustomerId: "cus_1",
        stripeEventAt: 200,
        subscriptionId: "sub_1",
        subscriptionStatus: "active",
      });
    });

    it("ends active when two events of one second arrive in the wrong order", async () => {
      await apply(
        subscriptionEvent("customer.subscription.updated", 100, "active")
      );
      await expect(
        apply(
          subscriptionEvent("customer.subscription.created", 100, "incomplete")
        )
      ).resolves.toBe("applied");
      const updated = await row();

      expect(updated?.subscriptionStatus).toBe("active");
    });

    it("ignores an event older than the one applied", async () => {
      await apply(
        subscriptionEvent("customer.subscription.updated", 200, "active")
      );

      await expect(
        apply(subscriptionEvent("customer.subscription.updated", 100, "active"))
      ).resolves.toBe("ignored");
    });

    it("marks a deleted subscription canceled", async () => {
      await apply(
        subscriptionEvent("customer.subscription.updated", 100, "active")
      );
      held = heldSubscription("canceled", { account_id: id });

      await expect(
        apply(
          subscriptionEvent("customer.subscription.deleted", 100, "canceled")
        )
      ).resolves.toBe("applied");
      const deleted = await row();

      expect(deleted?.subscriptionStatus).toBe("canceled");
    });

    it("ignores an event for an account that does not exist", async () => {
      held = heldSubscription("active", { account_id: "acc_gone" });

      await expect(
        apply(subscriptionEvent("customer.subscription.updated", 100, "active"))
      ).resolves.toBe("ignored");
      await expect(apply(checkoutEvent("acc_gone"))).resolves.toBe("ignored");
    });

    it("finds the account by its customer when the metadata lacks it", async () => {
      held = heldSubscription("past_due", {});
      await apply(checkoutEvent(id));

      await expect(
        apply(subscriptionEvent("customer.subscription.updated", 100, "active"))
      ).resolves.toBe("applied");
      const updated = await row();

      expect(updated?.subscriptionStatus).toBe("past_due");
    });

    it("throws BillingUnavailableError when Stripe cannot be read, so Stripe retries", async () => {
      answer = failing(500);

      await expect(
        apply(subscriptionEvent("customer.subscription.updated", 100, "active"))
      ).rejects.toBeInstanceOf(BillingUnavailableError);
      const unchanged = await row();

      expect(unchanged?.subscriptionStatus).toBeNull();
    });

    it("ignores an event type it does not handle, and a malformed one", async () => {
      await expect(
        apply({
          created: 100,
          data: { object: { id: "in_1" } },
          type: "invoice.paid",
        })
      ).resolves.toBe("ignored");
      await expect(apply("nonsense")).resolves.toBe("ignored");
      expect(sent).toHaveLength(0);
    });
  });

  describe(cancelAndRefund, () => {
    const subscribed = account({
      stripeCustomerId: "cus_1",
      subscriptionId: "sub_1",
      subscriptionStatus: "active",
    });

    const NOW_MS = Date.UTC(2026, 10, 24, 12);

    const FULL_RUN = [
      "GET /v1/subscriptions",
      "GET /v1/subscriptions/sub_1",
      "POST /v1/subscriptions/sub_1",
      "DELETE /v1/subscriptions/sub_1",
      "GET /v1/customers/cus_1",
      "GET /v1/invoice_payments",
      "GET /v1/refunds",
      "GET /v1/payment_intents/pi_1",
      "POST /v1/refunds",
      "GET /v1/customers/cus_1/balance_transactions",
      "POST /v1/customers/cus_1/balance_transactions",
    ];

    it("cancels with proration, refunds the credit and clears the balance, in order", async () => {
      answer = stripeAnswers();

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      expect(routesOf(sent)).toStrictEqual(FULL_RUN);
      expect(
        sent.every(
          (request) => request.headers.get("Stripe-Version") === STRIPE_VERSION
        )
      ).toBeTruthy();
    });

    it("lists every subscription of the customer, ended ones too", async () => {
      answer = stripeAnswers();

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      expect(Object.fromEntries(sent[0]?.query ?? [])).toStrictEqual({
        customer: "cus_1",
        limit: "100",
        status: "all",
      });
    });

    it("stamps the paid invoice, then cancels with proration and reads the final invoice", async () => {
      answer = stripeAnswers();

      await cancelAndRefund(ENV, subscribed, NOW_MS);
      const [, read, stamp, cancel] = sent;

      expect(read?.query.getAll("expand[]")).toStrictEqual(["latest_invoice"]);
      expect(Object.fromEntries(stamp?.form ?? [])).toStrictEqual({
        "metadata[refund_invoice]": "in_paid",
      });
      expect(Object.fromEntries(cancel?.query ?? [])).toStrictEqual({
        "expand[]": "latest_invoice",
        invoice_now: "true",
        prorate: "true",
      });
    });

    it("reads the current period's payment, its refunds and its charge", async () => {
      answer = stripeAnswers();

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      expect(
        Object.fromEntries(
          sentTo(sent, "GET /v1/invoice_payments")?.query ?? []
        )
      ).toStrictEqual({ invoice: "in_paid", status: "paid" });
      expect(
        Object.fromEntries(sentTo(sent, "GET /v1/refunds")?.query ?? [])
      ).toStrictEqual({ limit: "100", payment_intent: "pi_1" });
      expect(
        sentTo(sent, "GET /v1/payment_intents/pi_1")?.query.getAll("expand[]")
      ).toStrictEqual(["latest_charge"]);
    });

    it("refunds the credit once, and clears it off the balance", async () => {
      answer = stripeAnswers();

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      const refund = sentTo(sent, "POST /v1/refunds");

      const balance = sentTo(
        sent,
        "POST /v1/customers/cus_1/balance_transactions"
      );

      expect(Object.fromEntries(refund?.form ?? [])).toStrictEqual({
        amount: "1500",
        "metadata[subscription]": "sub_1",
        payment_intent: "pi_1",
      });
      expect(refund?.headers.get("Idempotency-Key")).toBe("refund-sub_1");
      expect(Object.fromEntries(balance?.form ?? [])).toStrictEqual({
        amount: "1500",
        currency: "eur",
        "metadata[subscription]": "sub_1",
      });
    });

    it("cancels every subscription of the customer that has not ended, not only the account's", async () => {
      answer = stripeAnswers({
        "DELETE /v1/subscriptions/sub_2": () =>
          reply({
            customer: "cus_1",
            id: "sub_2",
            latest_invoice: null,
            metadata: {},
            status: "canceled",
          }),
        "GET /v1/subscriptions": listing(
          ["sub_1", "active"],
          ["sub_2", "past_due"],
          ["sub_3", "canceled"],
          ["sub_4", "incomplete_expired"]
        ),
        "GET /v1/subscriptions/sub_2": pastDue("sub_2"),
      });

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      const deleted = routesOf(sent).filter((route) =>
        route.startsWith("DELETE")
      );

      expect(deleted).toStrictEqual([
        "DELETE /v1/subscriptions/sub_1",
        "DELETE /v1/subscriptions/sub_2",
      ]);
      expect(routesOf(sent)).not.toContain("GET /v1/subscriptions/sub_3");
      expect(routesOf(sent)).not.toContain("GET /v1/subscriptions/sub_4");
    });

    it("cancels a past_due subscription without proration and refunds nothing", async () => {
      answer = stripeAnswers({
        "DELETE /v1/subscriptions/sub_1": () =>
          reply({
            customer: "cus_1",
            id: "sub_1",
            latest_invoice: { ...PAID_INVOICE, amount_paid: 0, status: "open" },
            metadata: {},
            status: "canceled",
          }),
        "GET /v1/subscriptions/sub_1": () =>
          reply({
            customer: "cus_1",
            id: "sub_1",
            latest_invoice: { ...PAID_INVOICE, amount_paid: 0, status: "open" },
            metadata: {},
            status: "past_due",
          }),
      });

      await expect(
        cancelAndRefund(ENV, subscribed, NOW_MS)
      ).resolves.toBeUndefined();
      expect(routesOf(sent)).toStrictEqual([
        "GET /v1/subscriptions",
        "GET /v1/subscriptions/sub_1",
        "DELETE /v1/subscriptions/sub_1",
      ]);
      expect(sent[2]?.query.get("prorate")).toBe("false");
      expect(sent[2]?.query.get("invoice_now")).toBe("false");
    });

    it("cancels nothing Stripe has ended, incomplete_expired included", async () => {
      answer = stripeAnswers({
        "GET /v1/subscriptions/sub_1": () =>
          reply({
            customer: "cus_1",
            id: "sub_1",
            latest_invoice: { ...PAID_INVOICE, amount_paid: 0, status: "void" },
            metadata: {},
            status: "incomplete_expired",
          }),
      });

      // An account that names its subscription but no customer reads that subscription alone.
      await expect(
        cancelAndRefund(
          ENV,
          account({
            subscriptionId: "sub_1",
            subscriptionStatus: "incomplete",
          }),
          NOW_MS
        )
      ).resolves.toBeUndefined();
      expect(routesOf(sent)).toStrictEqual(["GET /v1/subscriptions/sub_1"]);
    });

    it("counts a subscription Stripe no longer has as nothing to cancel", async () => {
      answer = stripeAnswers({ "GET /v1/subscriptions/sub_1": missing });

      await expect(
        cancelAndRefund(ENV, account({ subscriptionId: "sub_1" }), NOW_MS)
      ).resolves.toBeUndefined();
      expect(routesOf(sent)).toStrictEqual(["GET /v1/subscriptions/sub_1"]);
    });

    it("counts a customer Stripe no longer has as nothing to cancel", async () => {
      answer = stripeAnswers({ "GET /v1/subscriptions": missing });

      await expect(
        cancelAndRefund(ENV, subscribed, NOW_MS)
      ).resolves.toBeUndefined();
      expect(routesOf(sent)).toStrictEqual(["GET /v1/subscriptions"]);
    });

    it("still fails on a 404 that is not a missing object", async () => {
      answer = stripeAnswers({ "GET /v1/subscriptions": failing(404) });

      await expect(
        cancelAndRefund(ENV, subscribed, NOW_MS)
      ).rejects.toBeInstanceOf(BillingUnavailableError);
    });

    it("refunds no more than the payment still holds after an earlier refund", async () => {
      answer = stripeAnswers({
        "GET /v1/payment_intents/pi_1": () =>
          reply({
            id: "pi_1",
            latest_charge: { amount_captured: 2000, amount_refunded: 1200 },
          }),
      });

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      const refund = sentTo(sent, "POST /v1/refunds");

      expect(refund?.form.get("amount")).toBe("800");
      expect(sent.at(-1)?.form.get("amount")).toBe("800");
    });

    it("refunds nothing, and still deletes, when the payment was refunded in full elsewhere", async () => {
      answer = stripeAnswers({
        "GET /v1/payment_intents/pi_1": () =>
          reply({
            id: "pi_1",
            latest_charge: { amount_captured: 2000, amount_refunded: 2000 },
          }),
      });

      await expect(
        cancelAndRefund(ENV, subscribed, NOW_MS)
      ).resolves.toBeUndefined();
      expect(routesOf(sent)).not.toContain("POST /v1/refunds");
    });

    it("on a retry after the refund went through, only clears the balance", async () => {
      answer = retrying({
        "GET /v1/refunds": () =>
          reply({
            data: [
              { amount: 900, id: "re_other", metadata: {} },
              { amount: 1500, id: "re_1", metadata: { subscription: "sub_1" } },
            ],
          }),
      });

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      expect(routesOf(sent)).toStrictEqual([
        "GET /v1/subscriptions",
        "GET /v1/subscriptions/sub_1",
        "GET /v1/customers/cus_1",
        "GET /v1/invoice_payments",
        "GET /v1/refunds",
        "GET /v1/customers/cus_1/balance_transactions",
        "POST /v1/customers/cus_1/balance_transactions",
      ]);
      expect(sent.at(-1)?.form.get("amount")).toBe("1500");
    });

    it("on a retry before the refund, refunds without cancelling again", async () => {
      answer = retrying();

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      expect(routesOf(sent)).not.toContain("DELETE /v1/subscriptions/sub_1");
      expect(routesOf(sent)).toContain("POST /v1/refunds");
    });

    it("on a retry after a failed balance step, tries it again with a new key", async () => {
      answer = stripeAnswers({
        "POST /v1/customers/cus_1/balance_transactions": failing(500),
      });

      await expect(
        cancelAndRefund(ENV, subscribed, NOW_MS)
      ).rejects.toBeInstanceOf(BillingUnavailableError);

      const failed = sent.at(-1)?.headers.get("Idempotency-Key");

      sent = [];
      answer = retrying({
        "GET /v1/refunds": () =>
          reply({
            data: [
              { amount: 1500, id: "re_1", metadata: { subscription: "sub_1" } },
            ],
          }),
      });

      await cancelAndRefund(ENV, subscribed, NOW_MS + MINUTE_MS);
      const retried = sent.at(-1);

      expect(`${retried?.method} ${retried?.path}`).toBe(
        "POST /v1/customers/cus_1/balance_transactions"
      );
      expect(retried?.headers.get("Idempotency-Key")).toMatch(
        /^balance-sub_1-/u
      );
      expect(retried?.headers.get("Idempotency-Key")).not.toBe(failed);
    });

    it("clears the balance once: not again when this subscription's adjustment is on it", async () => {
      answer = retrying({
        "GET /v1/customers/cus_1/balance_transactions": () =>
          reply({
            data: [
              {
                amount: 1500,
                id: "cbtxn_1",
                metadata: { subscription: "sub_1" },
              },
            ],
            has_more: false,
          }),
        "GET /v1/refunds": () =>
          reply({
            data: [
              { amount: 1500, id: "re_1", metadata: { subscription: "sub_1" } },
            ],
          }),
      });

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      expect(routesOf(sent).at(-1)).toBe(
        "GET /v1/customers/cus_1/balance_transactions"
      );
    });

    it("refunds nothing for a subscription canceled elsewhere", async () => {
      answer = stripeAnswers({
        "GET /v1/subscriptions": listing(["sub_1", "canceled"]),
      });

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      expect(routesOf(sent)).toStrictEqual(["GET /v1/subscriptions"]);
    });

    it("refunds nothing when the credit was already cleared", async () => {
      answer = stripeAnswers({
        "GET /v1/customers/cus_1": () =>
          reply({ balance: 0, currency: "eur", id: "cus_1" }),
      });

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      expect(routesOf(sent).at(-1)).toBe("GET /v1/customers/cus_1");
    });

    it("refunds nothing when the cancellation left no credit", async () => {
      answer = stripeAnswers({
        "DELETE /v1/subscriptions/sub_1": () =>
          reply({
            customer: "cus_1",
            id: "sub_1",
            latest_invoice: { ...FINAL_INVOICE, total: 0 },
            metadata: { refund_invoice: "in_paid" },
            status: "canceled",
          }),
      });

      await cancelAndRefund(ENV, subscribed, NOW_MS);

      expect(routesOf(sent).at(-1)).toBe("DELETE /v1/subscriptions/sub_1");
    });

    it("sends nothing for an account without a customer or a subscription", async () => {
      await cancelAndRefund(ENV, account(), NOW_MS);

      expect(sent).toHaveLength(0);
    });

    it("throws BillingUnavailableError when the first request fails", async () => {
      answer = failing(500);

      await expect(
        cancelAndRefund(ENV, subscribed, NOW_MS)
      ).rejects.toBeInstanceOf(BillingUnavailableError);
      expect(sent).toHaveLength(1);
    });

    it("throws BillingUnavailableError when the refund fails, and leaves the balance", async () => {
      answer = stripeAnswers({ "POST /v1/refunds": failing(402) });

      await expect(
        cancelAndRefund(ENV, subscribed, NOW_MS)
      ).rejects.toBeInstanceOf(BillingUnavailableError);
      expect(routesOf(sent).at(-1)).toBe("POST /v1/refunds");
    });
  });
});
