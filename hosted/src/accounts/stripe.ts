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
      client_reference_id: z.string().nullish(),
    }),
  }),
});

/** A subscription as Stripe holds it now; since basil its period is on its items. */
const HeldSubscription = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  metadata: z.object({ account_id: z.string().optional() }).nullish(),
  items: z.object({
    data: z.array(z.object({ current_period_end: z.number().int() })),
  }),
});

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/** The account a subscription is for: the id Checkout put in its metadata, or else the customer's. */
const accountOfSubscription = (
  db: D1Like,
  subscription: z.infer<typeof HeldSubscription>
): Promise<Account | null> => {
  const accountId = subscription.metadata?.account_id;

  return accountId === undefined
    ? accountByCustomer(db, subscription.customer)
    : accountById(db, accountId);
};

/**
 * Applies a webhook's event to the account it names. Anything else (another type, an account
 * deleted since, an event older than the row's) is `ignored`, which the webhook still answers 2xx,
 * so Stripe does not retry it.
 *
 * A subscription event writes the subscription as Stripe holds it now, read from the API, not the
 * event's payload: Stripe does not deliver in order, and `created` is whole seconds, so two events
 * of one second (`.created` then `.updated`, or `.updated` then `.deleted`) cannot be ordered by
 * it. Whichever arrives last writes the current state. A failed read throws BillingUnavailableError,
 * so the webhook answers non-2xx and Stripe retries.
 */
export const applyStripeEvent = async (
  env: StripeEnv,
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

  if (!SUBSCRIPTION_EVENTS.has(type) || !object.id) {
    return "ignored";
  }

  const subscription = await stripe(
    env,
    {
      method: "GET",
      path: `/v1/subscriptions/${encodeURIComponent(object.id)}`,
    },
    HeldSubscription
  );

  const periodEnd = subscription.items.data[0]?.current_period_end;
  const account = await accountOfSubscription(db, subscription);

  if (account === null || periodEnd === undefined) {
    return "ignored";
  }

  const written = await applySubscription(db, {
    accountId: account.id,
    currentPeriodEnd: periodEnd,
    customerId: subscription.customer,
    eventAt: created,
    status: subscription.status,
    subscriptionId: subscription.id,
  });

  return written ? "applied" : "ignored";
};

const Invoice = z.object({
  id: z.string(),
  status: z.string().nullable(),
  total: z.number().int(),
  amount_paid: z.number().int(),
  currency: z.string(),
});

const Subscription = z.object({
  status: z.string(),
  customer: z.string(),
  metadata: z.object({ refund_invoice: z.string().optional() }).nullish(),
  latest_invoice: Invoice.nullable(),
});

const Customer = z.object({
  balance: z.number().int(),
  currency: z.string().nullable(),
});

const InvoicePayments = z.object({
  data: z.array(
    z.object({
      amount_paid: z.number().int().nullable(),
      payment: z.object({ payment_intent: z.string().optional() }),
    })
  ),
});

const Refunds = z.object({
  data: z.array(
    z.object({
      amount: z.number().int(),
      metadata: z.object({ subscription: z.string().optional() }).nullish(),
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
 * - The credit lands on the customer's balance, not the card: "To refund your customer, issue
 *   refunds and then adjust their account balance back to zero"
 *   (https://docs.stripe.com/billing/subscriptions/cancel#prorate-for-usage-based-billing, and
 *   https://support.stripe.com/questions/refunding-credit-balance-to-customer-after-subscription-downgrade-or-cancellation).
 * - Since basil an invoice's payment is in `GET /v1/invoice_payments?invoice=`
 *   (https://docs.stripe.com/api/invoice-payment/list), and `POST /v1/refunds` takes its
 *   `payment_intent`, an `amount` and `metadata`; `GET /v1/refunds?payment_intent=` lists a
 *   payment's refunds (https://docs.stripe.com/refunds, https://docs.stripe.com/api/refunds/list).
 * - `POST /v1/customers/{id}/balance_transactions` with a positive `amount` takes the credit back
 *   off the balance (https://docs.stripe.com/billing/customer/balance#modifying).
 *
 * Only the current period is refunded, and only when its invoice (the subscription's latest, read
 * before the cancellation) is paid: a past_due subscription is canceled without proration, since
 * nobody paid for the time it would credit. That invoice's id is written to the subscription's
 * metadata before it is canceled, so a retry finds it on the canceled subscription; one canceled
 * elsewhere (at link.com, or by Stripe after failed payments) has none, and is refunded nothing.
 * A retry is safe at any time: the refund carries the subscription's id in its metadata and is not
 * made again when the payment already has it, and the balance step runs only while the balance
 * still holds the credit.
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

  let subscription = await stripe(
    env,
    {
      method: "GET",
      params: new URLSearchParams({ "expand[]": "latest_invoice" }),
      path,
    },
    Subscription
  );

  let refundInvoice = subscription.metadata?.refund_invoice;

  if (subscription.status !== "canceled") {
    const current = subscription.latest_invoice;

    const paid =
      current !== null && current.status === "paid" && current.amount_paid > 0;

    if (paid) {
      refundInvoice = current.id;
      await stripe(
        env,
        {
          method: "POST",
          params: new URLSearchParams({
            "metadata[refund_invoice]": current.id,
          }),
          path,
        },
        Created
      );
    }

    subscription = await stripe(
      env,
      {
        method: "DELETE",
        params: new URLSearchParams({
          "expand[]": "latest_invoice",
          invoice_now: String(paid),
          prorate: String(paid),
        }),
        path,
      },
      Subscription
    );
  }

  const finalInvoice = subscription.latest_invoice;

  if (
    refundInvoice === undefined ||
    finalInvoice === null ||
    finalInvoice.total >= 0
  ) {
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

  const payments = await stripe(
    env,
    {
      method: "GET",
      params: new URLSearchParams({ invoice: refundInvoice, status: "paid" }),
      path: "/v1/invoice_payments",
    },
    InvoicePayments
  );

  const payment = payments.data.find(
    (each) => each.payment.payment_intent !== undefined
  );

  const paymentIntent = payment?.payment.payment_intent;

  if (paymentIntent === undefined) {
    return;
  }

  const refunds = await stripe(
    env,
    {
      method: "GET",
      params: new URLSearchParams({
        limit: "100",
        payment_intent: paymentIntent,
      }),
      path: "/v1/refunds",
    },
    Refunds
  );

  const refunded = refunds.data.find(
    (refund) => refund.metadata?.subscription === subscriptionId
  );

  let amount = refunded?.amount;

  if (amount === undefined) {
    amount = Math.min(
      -finalInvoice.total,
      -customer.balance,
      payment?.amount_paid ?? 0
    );

    if (amount <= 0) {
      return;
    }

    await stripe(
      env,
      {
        idempotencyKey: `refund-${subscriptionId}`,
        method: "POST",
        params: new URLSearchParams({
          amount: String(amount),
          "metadata[subscription]": subscriptionId,
          payment_intent: paymentIntent,
        }),
        path: "/v1/refunds",
      },
      Created
    );
  }

  await stripe(
    env,
    {
      idempotencyKey: `balance-${subscriptionId}`,
      method: "POST",
      params: new URLSearchParams({
        amount: String(Math.min(amount, -customer.balance)),
        currency: customer.currency ?? finalInvoice.currency,
      }),
      path: `${customerPath}/balance_transactions`,
    },
    Created
  );
};
