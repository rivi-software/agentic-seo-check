/**
 * Stripe Managed Payments (issue #229): Stripe is the merchant of record, so a subscription starts
 * only through a Checkout Session with `managed_payments[enabled]=true`. Its REST API is called
 * through `fetch` with form encoding, which bundles for workerd without the `stripe` package. The
 * webhook writes what Stripe says about a subscription to the account's row; nothing else does.
 */
import { z } from "zod";

import { ExpectedError } from "../../../src/core/errors.js";
import type { D1Like } from "../d1.js";
import {
  accountByCustomer,
  accountById,
  applySubscription,
  linkCustomer,
} from "./store.js";
import type { Account } from "./store.js";

/**
 * The API version every request names, so a change to the account's default in the Dashboard
 * changes nothing here. Managed Payments needs `2025-03-31.basil` or later
 * (https://docs.stripe.com/payments/managed-payments/set-up), and since basil a subscription's
 * `current_period_end` is on its items and an invoice's payments are in `/v1/invoice_payments`.
 * The webhook endpoint in the Dashboard should name the same version, so events have this shape.
 */
export const STRIPE_VERSION = "2025-03-31.basil";

const API = "https://api.stripe.com";

/** How old a webhook's signed time may be, as Stripe's own libraries allow. */
const TOLERANCE_SECONDS = 300;

export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** The one price a subscription has, a Stripe setting so the price changes without a deploy. */
  STRIPE_PRICE?: string;
}

/** Stripe failed or is not set up: the page asks the user to try again, and nothing is reported. */
export class BillingUnavailableError extends ExpectedError {
  override name = "BillingUnavailableError";

  constructor(options: ErrorOptions = {}) {
    super("Payments are unavailable right now. Try again in a few minutes.", {
      ...options,
      reason: "billing",
    });
  }
}

export const billingOpen = (env: StripeEnv): boolean =>
  Boolean(env.STRIPE_SECRET_KEY) &&
  Boolean(env.STRIPE_WEBHOOK_SECRET) &&
  Boolean(env.STRIPE_PRICE);

interface StripeRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  params?: URLSearchParams;
  /** Makes a retry of a request that moves money do nothing new, for Stripe's 24 hours. */
  idempotencyKey?: string;
}

/** One call to Stripe's API, read through `schema`. Any failure is a BillingUnavailableError. */
const stripe = async <T>(
  env: StripeEnv,
  request: StripeRequest,
  schema: z.ZodType<T>
): Promise<T> => {
  const key = env.STRIPE_SECRET_KEY;

  if (!key) {
    throw new BillingUnavailableError();
  }

  const params = request.params ?? new URLSearchParams();
  // As Stripe's own libraries do, a GET or a DELETE carries its parameters in the query.
  const inQuery = request.method !== "POST";
  const query = inQuery && params.size > 0 ? `?${params}` : "";

  const headers = new Headers({
    Authorization: `Bearer ${key}`,
    "Stripe-Version": STRIPE_VERSION,
  });

  if (!inQuery) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }

  if (request.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", request.idempotencyKey);
  }

  let response: Response;

  try {
    response = await fetch(`${API}${request.path}${query}`, {
      body: inQuery ? undefined : params.toString(),
      headers,
      method: request.method,
    });
  } catch (error) {
    throw new BillingUnavailableError({ cause: error });
  }

  if (!response.ok) {
    // Stripe's error body can name the customer, so it stays out of the error.
    await response.body?.cancel();
    throw new BillingUnavailableError();
  }

  const parsed = schema.safeParse(await response.json().catch(() => null));

  if (!parsed.success) {
    throw new BillingUnavailableError();
  }

  return parsed.data;
};

const SessionUrl = z.object({ url: z.string() });

export const checkoutUrl = async (
  env: StripeEnv,
  account: Account,
  origin: string
): Promise<string> => {
  if (!billingOpen(env)) {
    throw new BillingUnavailableError();
  }

  const params = new URLSearchParams({
    mode: "subscription",
    "managed_payments[enabled]": "true",
    "line_items[0][price]": env.STRIPE_PRICE ?? "",
    "line_items[0][quantity]": "1",
    client_reference_id: account.id,
    "subscription_data[metadata][account_id]": account.id,
    success_url: `${origin}/account`,
    cancel_url: `${origin}/account`,
  });

  if (account.stripeCustomerId !== null) {
    params.set("customer", account.stripeCustomerId);
  }

  const session = await stripe(
    env,
    { method: "POST", params, path: "/v1/checkout/sessions" },
    SessionUrl
  );

  return session.url;
};

/** Stripe's customer portal; Managed Payments also lets the customer manage it at link.com. */
export const portalUrl = async (
  env: StripeEnv,
  account: Account,
  origin: string
): Promise<string> => {
  if (account.stripeCustomerId === null) {
    // The account page offers the portal only to an account with a customer.
    throw new Error("portalUrl needs an account with a Stripe customer");
  }

  const session = await stripe(
    env,
    {
      method: "POST",
      params: new URLSearchParams({
        customer: account.stripeCustomerId,
        return_url: `${origin}/account`,
      }),
      path: "/v1/billing_portal/sessions",
    },
    SessionUrl
  );

  return session.url;
};

const hmacHex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** Compares every character, so the time taken says nothing of how much of a guess was right. */
const sameHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < a.length; index += 1) {
    // oxlint-disable-next-line no-bitwise -- a constant-time comparison is bitwise by nature
    difference |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0);
  }

  return difference === 0;
};

/**
 * Checks `Stripe-Signature` as https://docs.stripe.com/webhooks#verify-manually describes: an
 * HMAC-SHA256 of `${t}.${rawBody}` with the endpoint's secret, against any `v1` (there are two
 * while a secret rolls), with `t` within five minutes of now, in either direction.
 */
export const verifyStripeSignature = async (
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds: number
): Promise<boolean> => {
  if (header === null || secret === "") {
    return false;
  }

  let time: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const [name, value = ""] = part.trim().split("=", 2);

    if (name === "t" && /^\d+$/u.test(value)) {
      time = Number(value);
    } else if (name === "v1") {
      signatures.push(value);
    }
  }

  if (
    time === undefined ||
    signatures.length === 0 ||
    Math.abs(nowSeconds - time) > TOLERANCE_SECONDS
  ) {
    return false;
  }

  const expected = await hmacHex(secret, `${time}.${rawBody}`);

  // Each signature is compared, so the time taken does not say which one matched.
  return signatures
    .map((signature) => sameHex(signature, expected))
    .includes(true);
};

/** The fields of an event this reads; Stripe sends many more. */
const StripeEvent = z.object({
  type: z.string(),
  created: z.number().int(),
  data: z.object({
    object: z.object({
      id: z.string().optional(),
      customer: z.string().nullish(),
      status: z.string().optional(),
      metadata: z.object({ account_id: z.string().optional() }).nullish(),
      client_reference_id: z.string().nullish(),
      items: z
        .object({
          data: z.array(
            z.object({ current_period_end: z.number().int().optional() })
          ),
        })
        .optional(),
    }),
  }),
});

type StripeObject = z.infer<typeof StripeEvent>["data"]["object"];

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/** The account an event is about: the id Checkout put in the metadata, or else the customer's. */
const accountOfSubscription = (
  db: D1Like,
  object: StripeObject
): Promise<Account | null> => {
  const accountId = object.metadata?.account_id;

  if (accountId !== undefined) {
    return accountById(db, accountId);
  }

  return object.customer
    ? accountByCustomer(db, object.customer)
    : Promise.resolve(null);
};

/**
 * Applies a webhook's event to the account it names. Anything else (another type, an account
 * deleted since, an event older than the row's) is `ignored`, which the webhook still answers 2xx,
 * so Stripe does not retry it.
 */
export const applyStripeEvent = async (
  db: D1Like,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the webhook's JSON, parsed here
  event: unknown
): Promise<"applied" | "ignored"> => {
  const parsed = StripeEvent.safeParse(event);

  if (!parsed.success) {
    return "ignored";
  }

  const { type, created, data } = parsed.data;
  const { object } = data;

  if (type === "checkout.session.completed") {
    const accountId = object.client_reference_id;
    const { customer } = object;

    if (
      !accountId ||
      !customer ||
      (await accountById(db, accountId)) === null
    ) {
      return "ignored";
    }

    await linkCustomer(db, accountId, customer);

    return "applied";
  }

  if (!SUBSCRIPTION_EVENTS.has(type)) {
    return "ignored";
  }

  const periodEnd = object.items?.data[0]?.current_period_end;
  const account = await accountOfSubscription(db, object);

  if (
    account === null ||
    !object.id ||
    !object.customer ||
    object.status === undefined ||
    periodEnd === undefined
  ) {
    return "ignored";
  }

  const written = await applySubscription(db, {
    accountId: account.id,
    currentPeriodEnd: periodEnd,
    customerId: object.customer,
    eventAt: created,
    status:
      type === "customer.subscription.deleted" ? "canceled" : object.status,
    subscriptionId: object.id,
  });

  return written ? "applied" : "ignored";
};

const Subscription = z.object({
  status: z.string(),
  customer: z.string(),
  latest_invoice: z
    .object({ id: z.string(), total: z.number().int(), currency: z.string() })
    .nullable(),
});

const Customer = z.object({
  balance: z.number().int(),
  currency: z.string().nullable(),
});

const Invoices = z.object({
  data: z.array(z.object({ id: z.string(), amount_paid: z.number().int() })),
});

const InvoicePayments = z.object({
  data: z.array(
    z.object({
      payment: z.object({ payment_intent: z.string().optional() }),
    })
  ),
});

const Created = z.object({ id: z.string() });

/**
 * Ends an account's subscription now and refunds the unused time, before the account is deleted.
 *
 * What Stripe's docs say, and what this does in that order:
 * - Managed Payments lets the business "issue refunds and update subscriptions in the Dashboard or
 *   with the API" (https://docs.stripe.com/payments/managed-payments/how-it-works).
 * - `DELETE /v1/subscriptions/{id}` cancels now; `prorate=true` "will generate a proration
 *   invoice item that credits remaining unused time until the subscription period end" and
 *   `invoice_now=true` puts it on a final invoice (https://docs.stripe.com/api/subscriptions/cancel).
 *   This reads the subscription first and cancels only one that is not canceled yet, so a retry
 *   after a later step failed does not fail on the cancellation.
 * - The credit lands on the customer's balance, not the card: "To refund your customer, issue
 *   refunds and then adjust their account balance back to zero"
 *   (https://docs.stripe.com/billing/subscriptions/cancel#prorate-for-usage-based-billing, and
 *   https://support.stripe.com/questions/refunding-credit-balance-to-customer-after-subscription-downgrade-or-cancellation,
 *   which refunds the subscription's paid invoices' charges up to the credit).
 * - Since basil an invoice's payment is in `GET /v1/invoice_payments?invoice=`
 *   (https://docs.stripe.com/api/invoice-payment/list), and `POST /v1/refunds` takes its
 *   `payment_intent` and an `amount` (https://docs.stripe.com/refunds).
 * - `POST /v1/customers/{id}/balance_transactions` with a positive `amount` takes the credit back
 *   off the balance (https://docs.stripe.com/billing/customer/balance#modifying).
 *
 * The credit refunded is the final invoice's, and only while the balance still holds it: a retry
 * after the balance was cleared refunds nothing, and the idempotency keys make a retry within
 * Stripe's 24 hours of a refund or an adjustment that went through do nothing new.
 */
export const cancelAndRefund = async (
  env: StripeEnv,
  account: Account
): Promise<void> => {
  const { subscriptionId } = account;

  if (subscriptionId === null) {
    return;
  }

  const path = `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const expand = new URLSearchParams({ "expand[]": "latest_invoice" });

  let subscription = await stripe(
    env,
    { method: "GET", params: expand, path },
    Subscription
  );

  if (subscription.status !== "canceled") {
    subscription = await stripe(
      env,
      {
        method: "DELETE",
        params: new URLSearchParams({
          "expand[]": "latest_invoice",
          invoice_now: "true",
          prorate: "true",
        }),
        path,
      },
      Subscription
    );
  }

  const finalInvoice = subscription.latest_invoice;

  if (finalInvoice === null || finalInvoice.total >= 0) {
    return;
  }

  const customerPath = `/v1/customers/${encodeURIComponent(subscription.customer)}`;

  const customer = await stripe(
    env,
    { method: "GET", path: customerPath },
    Customer
  );

  if (customer.balance >= 0) {
    return;
  }

  const credit = Math.min(-finalInvoice.total, -customer.balance);

  const invoices = await stripe(
    env,
    {
      method: "GET",
      params: new URLSearchParams({
        limit: "10",
        status: "paid",
        subscription: subscriptionId,
      }),
      path: "/v1/invoices",
    },
    Invoices
  );

  // Stripe lists the newest first; the final invoice paid nothing, so this is the last payment.
  const paid = invoices.data.find((invoice) => invoice.amount_paid > 0);

  if (paid === undefined) {
    return;
  }

  const payments = await stripe(
    env,
    {
      method: "GET",
      params: new URLSearchParams({ invoice: paid.id, status: "paid" }),
      path: "/v1/invoice_payments",
    },
    InvoicePayments
  );

  const paymentIntent = payments.data.find(
    (payment) => payment.payment.payment_intent !== undefined
  )?.payment.payment_intent;

  if (paymentIntent === undefined) {
    return;
  }

  const amount = String(Math.min(credit, paid.amount_paid));

  await stripe(
    env,
    {
      idempotencyKey: `refund-${subscriptionId}`,
      method: "POST",
      params: new URLSearchParams({ amount, payment_intent: paymentIntent }),
      path: "/v1/refunds",
    },
    Created
  );
  await stripe(
    env,
    {
      idempotencyKey: `balance-${subscriptionId}`,
      method: "POST",
      params: new URLSearchParams({
        amount,
        currency: customer.currency ?? finalInvoice.currency,
      }),
      path: `${customerPath}/balance_transactions`,
    },
    Created
  );
};
