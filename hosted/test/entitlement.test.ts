/** The entitlement of an account against the migration's own tables in SQLite. */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import { applySubscription, accountForSignIn } from "../src/accounts/store.ts";
import type { D1Like } from "../src/d1.ts";
import { entitlement } from "../src/entitlement.ts";
import { d1Of } from "./helpers/d1.ts";

const MIGRATION = readFileSync(
  new URL("../migrations-accounts/0001_accounts.sql", import.meta.url),
  "utf-8"
);

const NOW = Date.UTC(2026, 10, 24, 12);
const FUTURE = Math.floor(NOW / 1000) + 86_400;
const PAST = Math.floor(NOW / 1000) - 86_400;

let db: DatabaseSync;
let prepared = 0;

interface AccountsEnv {
  ACCOUNTS: D1Like;
}

let env: AccountsEnv;

/** An account with a subscription in `status`, ending at `periodEnd` (Unix seconds). */
const accountWith = async (
  status: string,
  periodEnd: number
): Promise<string> => {
  const account = await accountForSignIn(
    d1Of(db),
    `${status}-${periodEnd}@example.com`,
    NOW
  );

  await applySubscription(d1Of(db), {
    accountId: account.id,
    currentPeriodEnd: periodEnd,
    customerId: `cus_${status}`,
    eventAt: 1,
    status,
    subscriptionId: `sub_${status}`,
  });

  return account.id;
};

describe(entitlement, () => {
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(MIGRATION);
    prepared = 0;
    const real = d1Of(db);

    const counting: D1Like = {
      prepare: (sql) => {
        prepared += 1;

        return real.prepare(sql);
      },
    };

    env = { ACCOUNTS: counting };
  });

  it("is a subscription while active, trialing and in its period", async () => {
    for (const status of ["active", "trialing"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one account after another
      const id = await accountWith(status, FUTURE);
      // oxlint-disable-next-line eslint/no-await-in-loop -- as above
      const { account, paid } = await entitlement(env, id, NOW);

      expect(paid).toBe("subscription");
      expect(account?.id).toBe(id);
    }
  });

  it("is not paid when past_due, canceled, or active with an ended period", async () => {
    for (const [status, end] of [
      ["past_due", FUTURE],
      ["canceled", FUTURE],
      ["active", PAST],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one account after another
      const id = await accountWith(status, end);
      // oxlint-disable-next-line eslint/no-await-in-loop -- as above
      const { account, paid } = await entitlement(env, id, NOW);

      expect(paid).toBeNull();
      expect(account?.id).toBe(id);
    }
  });

  it("answers no account and not paid for an unknown id", async () => {
    await expect(entitlement(env, "acc_nobody", NOW)).resolves.toStrictEqual({
      account: null,
      paid: null,
    });
  });

  it("asks the database once a minute for an account", async () => {
    const id = await accountWith("active", FUTURE);
    prepared = 0;

    await entitlement(env, id, NOW);
    expect(prepared).toBe(1);

    await entitlement(env, id, NOW + 59_000);
    expect(prepared).toBe(1);

    await entitlement(env, id, NOW + 61_000);
    expect(prepared).toBe(2);
  });
});
