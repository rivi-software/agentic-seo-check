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

const subscriptionEvent = (
  type: string,
  created: number,
  status: string,
  metadata: Record<string, string>
): EventFixture => ({
  created,
  data: {
    object: {
      customer: "cus_1",
      id: "sub_1",
      items: { data: [{ current_period_end: 1_800_000_000 }] },
      metadata,
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
      case "GET /v1/subscriptions/sub_1": {
        return reply({
          customer: "cus_1",
          id: "sub_1",
          latest_invoice: { currency: "eur", id: "in_paid", total: 2000 },
          status: "active",
        });
      }

      case "DELETE /v1/subscriptions/sub_1": {
        return reply({
          customer: "cus_1",
          id: "sub_1",
          latest_invoice: { currency: "eur", id: "in_final", total: -1500 },
          status: "canceled",
        });
      }

      case "GET /v1/customers/cus_1": {
        return reply({ balance: -1500, currency: "eur", id: "cus_1" });
      }

      case "GET /v1/invoices": {
        return reply({
          data: [
            { amount_paid: 0, currency: "eur", id: "in_final" },
            { amount_paid: 2000, currency: "eur", id: "in_paid" },
          ],
        });
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

      default: {
        return reply({ id: "ok" });
      }
    }
  };

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
    it("opens a Managed Payments subscription for the account", async () => {
      answer = () => reply({ url: "https://checkout.stripe.com/c/pay/cs_1" });

      await expect(checkoutUrl(ENV, account(), ORIGIN)).resolves.toBe(
        "https://checkout.stripe.com/c/pay/cs_1"
      );
      expect(routesOf(sent)).toStrictEqual(["POST /v1/checkout/sessions"]);
      expect(Object.fromEntries(sent[0]?.form ?? [])).toStrictEqual({
        cancel_url: `${ORIGIN}/account`,
        client_reference_id: "acc_1",
        "line_items[0][price]": "price_123",
        "line_items[0][quantity]": "1",
        "managed_payments[enabled]": "true",
        mode: "subscription",
        "subscription_data[metadata][account_id]": "acc_1",
        success_url: `${ORIGIN}/account`,
      });
    });

    it("sends the pinned API version and the secret key", async () => {
      answer = () => reply({ url: "https://checkout.stripe.com/c/pay/cs_1" });

      await checkoutUrl(ENV, account(), ORIGIN);
      const [request] = sent;

      expect(request?.headers.get("Stripe-Version")).toBe(STRIPE_VERSION);
      expect(request?.headers.get("Authorization")).toBe("Bearer sk_test_123");
    });

    it("names the customer when the account has one", async () => {
      answer = () => reply({ url: "https://checkout.stripe.com/c/pay/cs_2" });

      await checkoutUrl(ENV, account({ stripeCustomerId: "cus_1" }), ORIGIN);

      expect(sent[0]?.form.get("customer")).toBe("cus_1");
    });

    it("throws BillingUnavailableError when Stripe fails", async () => {
      answer = failing(500);

      await expect(checkoutUrl(ENV, account(), ORIGIN)).rejects.toBeInstanceOf(
        BillingUnavailableError
      );
    });

    it("throws BillingUnavailableError while billing is not set up", async () => {
      await expect(
        checkoutUrl({ ...ENV, STRIPE_PRICE: "" }, account(), ORIGIN)
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

    const row = (): Promise<Account | null> => accountById(d1Of(db), id);

    beforeEach(async () => {
      db = new DatabaseSync(":memory:");
      db.exec(
        readFileSync(
          new URL("../migrations-accounts/0001_accounts.sql", import.meta.url),
          "utf-8"
        )
      );

      const created = await accountForSignIn(
        d1Of(db),
        "ada@example.com",
        Date.now()
      );

      ({ id } = created);
    });

    it("links the customer when a checkout completes", async () => {
      await expect(applyStripeEvent(d1Of(db), checkoutEvent(id))).resolves.toBe(
        "applied"
      );
      const linked = await row();

      expect(linked?.stripeCustomerId).toBe("cus_1");
    });

    it("keeps the newer status when an older update arrives late", async () => {
      const metadata = { account_id: id };

      await expect(
        applyStripeEvent(
          d1Of(db),
          subscriptionEvent(
            "customer.subscription.updated",
            200,
            "active",
            metadata
          )
        )
      ).resolves.toBe("applied");
      await expect(
        applyStripeEvent(
          d1Of(db),
          subscriptionEvent(
            "customer.subscription.updated",
            100,
            "incomplete",
            metadata
          )
        )
      ).resolves.toBe("ignored");
      const updated = await row();

      expect(updated).toMatchObject({
        currentPeriodEnd: 1_800_000_000,
        stripeCustomerId: "cus_1",
        stripeEventAt: 200,
        subscriptionId: "sub_1",
        subscriptionStatus: "active",
      });
    });

    it("writes a new subscription", async () => {
      await expect(
        applyStripeEvent(
          d1Of(db),
          subscriptionEvent("customer.subscription.created", 100, "active", {
            account_id: id,
          })
        )
      ).resolves.toBe("applied");
      const created = await row();

      expect(created?.subscriptionStatus).toBe("active");
    });

    it("marks a deleted subscription canceled", async () => {
      const metadata = { account_id: id };

      await applyStripeEvent(
        d1Of(db),
        subscriptionEvent(
          "customer.subscription.updated",
          100,
          "active",
          metadata
        )
      );
      await expect(
        applyStripeEvent(
          d1Of(db),
          subscriptionEvent(
            "customer.subscription.deleted",
            200,
            "canceled",
            metadata
          )
        )
      ).resolves.toBe("applied");
      const deleted = await row();

      expect(deleted?.subscriptionStatus).toBe("canceled");
    });

    it("ignores an event for an account that does not exist", async () => {
      await expect(
        applyStripeEvent(
          d1Of(db),
          subscriptionEvent("customer.subscription.updated", 100, "active", {
            account_id: "acc_gone",
          })
        )
      ).resolves.toBe("ignored");
      await expect(
        applyStripeEvent(d1Of(db), checkoutEvent("acc_gone"))
      ).resolves.toBe("ignored");
    });

    it("finds the account by its customer when the metadata lacks it", async () => {
      await applyStripeEvent(d1Of(db), checkoutEvent(id));

      await expect(
        applyStripeEvent(
          d1Of(db),
          subscriptionEvent(
            "customer.subscription.updated",
            100,
            "past_due",
            {}
          )
        )
      ).resolves.toBe("applied");
      const updated = await row();

      expect(updated?.subscriptionStatus).toBe("past_due");
    });

    it("ignores an event type it does not handle, and a malformed one", async () => {
      await expect(
        applyStripeEvent(d1Of(db), {
          created: 100,
          data: { object: { id: "in_1" } },
          type: "invoice.paid",
        })
      ).resolves.toBe("ignored");
      await expect(applyStripeEvent(d1Of(db), "nonsense")).resolves.toBe(
        "ignored"
      );
    });
  });

  describe(cancelAndRefund, () => {
    const subscribed = account({
      stripeCustomerId: "cus_1",
      subscriptionId: "sub_1",
      subscriptionStatus: "active",
    });

    it("cancels with proration, refunds the credit and clears the balance, in order", async () => {
      answer = stripeAnswers();

      await cancelAndRefund(ENV, subscribed);

      expect(routesOf(sent)).toStrictEqual([
        "GET /v1/subscriptions/sub_1",
        "DELETE /v1/subscriptions/sub_1",
        "GET /v1/customers/cus_1",
        "GET /v1/invoices",
        "GET /v1/invoice_payments",
        "POST /v1/refunds",
        "POST /v1/customers/cus_1/balance_transactions",
      ]);
      expect(
        sent.every(
          (request) => request.headers.get("Stripe-Version") === STRIPE_VERSION
        )
      ).toBeTruthy();
    });

    it("asks Stripe to prorate and invoice now, and reads the final invoice", async () => {
      answer = stripeAnswers();

      await cancelAndRefund(ENV, subscribed);
      const [read, cancel] = sent;

      expect(read?.query.getAll("expand[]")).toStrictEqual(["latest_invoice"]);
      expect(Object.fromEntries(cancel?.query ?? [])).toStrictEqual({
        "expand[]": "latest_invoice",
        invoice_now: "true",
        prorate: "true",
      });
    });

    it("finds the payment of the last paid invoice", async () => {
      answer = stripeAnswers();

      await cancelAndRefund(ENV, subscribed);
      const invoices = sent.at(3);
      const payments = sent.at(4);

      expect(Object.fromEntries(invoices?.query ?? [])).toStrictEqual({
        limit: "10",
        status: "paid",
        subscription: "sub_1",
      });
      expect(Object.fromEntries(payments?.query ?? [])).toStrictEqual({
        invoice: "in_paid",
        status: "paid",
      });
    });

    it("refunds the credit once and clears it from the balance", async () => {
      answer = stripeAnswers();

      await cancelAndRefund(ENV, subscribed);
      const [refund, balance] = sent.slice(-2);

      expect(Object.fromEntries(refund?.form ?? [])).toStrictEqual({
        amount: "1500",
        payment_intent: "pi_1",
      });
      expect(refund?.headers.get("Idempotency-Key")).toBe("refund-sub_1");
      expect(Object.fromEntries(balance?.form ?? [])).toStrictEqual({
        amount: "1500",
        currency: "eur",
      });
      expect(balance?.headers.get("Idempotency-Key")).toBe("balance-sub_1");
    });

    it("does not cancel twice when a retry finds the subscription canceled", async () => {
      answer = stripeAnswers({
        "GET /v1/subscriptions/sub_1": () =>
          reply({
            customer: "cus_1",
            id: "sub_1",
            latest_invoice: { currency: "eur", id: "in_final", total: -1500 },
            status: "canceled",
          }),
      });

      await cancelAndRefund(ENV, subscribed);

      expect(routesOf(sent)).not.toContain("DELETE /v1/subscriptions/sub_1");
      expect(routesOf(sent)).toContain("POST /v1/refunds");
    });

    it("refunds nothing when the credit was already refunded", async () => {
      answer = stripeAnswers({
        "GET /v1/customers/cus_1": () =>
          reply({ balance: 0, currency: "eur", id: "cus_1" }),
      });

      await cancelAndRefund(ENV, subscribed);

      expect(routesOf(sent)).not.toContain("POST /v1/refunds");
    });

    it("refunds nothing when the cancellation left no credit", async () => {
      answer = stripeAnswers({
        "DELETE /v1/subscriptions/sub_1": () =>
          reply({
            customer: "cus_1",
            id: "sub_1",
            latest_invoice: { currency: "eur", id: "in_final", total: 0 },
            status: "canceled",
          }),
      });

      await cancelAndRefund(ENV, subscribed);

      expect(sent).toHaveLength(2);
    });

    it("sends nothing for an account without a subscription", async () => {
      await cancelAndRefund(ENV, account());

      expect(sent).toHaveLength(0);
    });

    it("throws BillingUnavailableError when the first request fails", async () => {
      answer = failing(500);

      await expect(cancelAndRefund(ENV, subscribed)).rejects.toBeInstanceOf(
        BillingUnavailableError
      );
      expect(sent).toHaveLength(1);
    });

    it("throws BillingUnavailableError when the refund fails, and leaves the balance", async () => {
      answer = stripeAnswers({ "POST /v1/refunds": failing(402) });

      await expect(cancelAndRefund(ENV, subscribed)).rejects.toBeInstanceOf(
        BillingUnavailableError
      );
      expect(routesOf(sent).at(-1)).toBe("POST /v1/refunds");
    });
  });
});
