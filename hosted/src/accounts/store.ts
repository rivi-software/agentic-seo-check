/**
 * The premium accounts in the EU D1 database `ACCOUNTS` (migrations-accounts/0001_accounts.sql):
 * one row per address, with Stripe's customer and subscription as the last webhook left them.
 * An account keeps no audits and no sites.
 */
import type { D1Like } from "../d1.js";
import { randomSecret } from "../secrets.js";
import { normalEmail } from "../site/waitlist.js";

export interface Account {
  id: string;
  email: string;
  stripeCustomerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  /** Unix seconds, as Stripe sends it. */
  currentPeriodEnd: number | null;
  /** Unix seconds, of the Stripe event last applied. */
  stripeEventAt: number | null;
}

interface Row {
  id: string;
  email: string;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
  current_period_end: number | null;
  stripe_event_at: number | null;
}

const accountOf = (row: Row): Account => ({
  currentPeriodEnd: row.current_period_end,
  email: row.email,
  id: row.id,
  stripeCustomerId: row.stripe_customer_id,
  stripeEventAt: row.stripe_event_at,
  subscriptionId: row.subscription_id,
  subscriptionStatus: row.subscription_status,
});

/** The account of an address, made on its first sign-in. `now` is in milliseconds. */
export const accountForSignIn = async (
  db: D1Like,
  email: string,
  now: number
): Promise<Account> => {
  const normal = normalEmail(email);

  if (normal === null) {
    // Callers pass addresses they have checked, so this is a bug, not a user's mistake.
    throw new Error("accountForSignIn needs a checked email address");
  }

  const row = await db
    .prepare(
      `INSERT INTO accounts (id, email, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET updated_at = excluded.updated_at
       RETURNING *`
    )
    .bind(`acc_${randomSecret(16)}`, normal, now, now)
    .first<Row>();

  if (row === null) {
    throw new Error("The accounts database returned no row for a sign-in");
  }

  return accountOf(row);
};

export const accountById = async (
  db: D1Like,
  id: string
): Promise<Account | null> => {
  const row = await db
    .prepare("SELECT * FROM accounts WHERE id = ?")
    .bind(id)
    .first<Row>();

  return row === null ? null : accountOf(row);
};

export const accountByCustomer = async (
  db: D1Like,
  customerId: string
): Promise<Account | null> => {
  const row = await db
    .prepare("SELECT * FROM accounts WHERE stripe_customer_id = ?")
    .bind(customerId)
    .first<Row>();

  return row === null ? null : accountOf(row);
};

export const linkCustomer = async (
  db: D1Like,
  id: string,
  customerId: string
): Promise<void> => {
  await db
    .prepare(
      "UPDATE accounts SET stripe_customer_id = ?, updated_at = ? WHERE id = ?"
    )
    .bind(customerId, Date.now(), id)
    .run();
};

/**
 * Writes a subscription from a Stripe event, unless a newer event already did (Stripe does not
 * deliver in order). Returns whether it wrote. Times are Stripe's, in seconds.
 */
export const applySubscription = async (
  db: D1Like,
  update: {
    accountId: string;
    customerId: string;
    subscriptionId: string;
    status: string;
    currentPeriodEnd: number;
    eventAt: number;
  }
): Promise<boolean> => {
  const row = await db
    .prepare(
      `UPDATE accounts
       SET stripe_customer_id = ?, subscription_id = ?, subscription_status = ?,
           current_period_end = ?, stripe_event_at = ?, updated_at = ?
       WHERE id = ? AND (stripe_event_at IS NULL OR stripe_event_at < ?)
       RETURNING id`
    )
    .bind(
      update.customerId,
      update.subscriptionId,
      update.status,
      update.currentPeriodEnd,
      update.eventAt,
      Date.now(),
      update.accountId,
      update.eventAt
    )
    .first<{ id: string }>();

  return row !== null;
};

export const deleteAccount = async (db: D1Like, id: string): Promise<void> => {
  await db.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
};
