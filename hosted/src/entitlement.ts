/**
 * What an account has paid for. One read of the account decides, and each isolate keeps the answer
 * for a minute, so a busy agent does not ask the database on every call.
 */
import type { HostedPaid } from "../../src/mcp-hosted.js";
import { accountById } from "./accounts/store.js";
import type { Account } from "./accounts/store.js";
import type { D1Like } from "./d1.js";

/** How a call is paid for. `per_call` is produced by nothing yet (issue #229, step 4). */
export type Paid = HostedPaid;

export interface Entitlement {
  account: Account | null;
  paid: Paid | null;
}

/** How long an isolate trusts an answer: a cancellation takes at most this long to show. */
export const ENTITLEMENT_TTL_MS = 60_000;

/** The most accounts an isolate keeps, the oldest dropped first. */
export const ENTITLEMENT_ENTRIES = 1024;

const cache = new Map<string, { at: number; answer: Entitlement }>();

/** `now` is in milliseconds, `currentPeriodEnd` in Unix seconds, as Stripe sends it. */
const paidOf = (account: Account | null, now: number): Paid | null =>
  account !== null &&
  (account.subscriptionStatus === "active" ||
    account.subscriptionStatus === "trialing") &&
  account.currentPeriodEnd !== null &&
  account.currentPeriodEnd * 1000 > now
    ? "subscription"
    : null;

export const entitlement = async (
  env: { ACCOUNTS: D1Like },
  accountId: string,
  now: number
): Promise<Entitlement> => {
  const kept = cache.get(accountId);

  if (kept !== undefined && now - kept.at < ENTITLEMENT_TTL_MS) {
    return kept.answer;
  }

  const account = await accountById(env.ACCOUNTS, accountId);
  const answer: Entitlement = { account, paid: paidOf(account, now) };

  // Re-insert so the map's order is the order of the answers, and drop the oldest past the cap.
  cache.delete(accountId);
  cache.set(accountId, { at: now, answer });

  for (const key of cache.keys()) {
    if (cache.size <= ENTITLEMENT_ENTRIES) {
      break;
    }

    cache.delete(key);
  }

  return answer;
};
