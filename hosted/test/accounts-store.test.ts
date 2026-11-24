/** The accounts store against the migration's own tables in SQLite. */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  accountByCustomer,
  accountById,
  accountForSignIn,
  applySubscription,
  deleteAccount,
  linkCustomer,
} from "../src/accounts/store.ts";
import { d1Of } from "./helpers/d1.ts";

const MIGRATION = readFileSync(
  new URL("../migrations-accounts/0001_accounts.sql", import.meta.url),
  "utf-8"
);

const NOW = Date.UTC(2026, 10, 24, 12);

let db: DatabaseSync;

const subscription = (status: string, eventAt: number) => ({
  accountId: "",
  currentPeriodEnd: 1_800_000_000,
  customerId: "cus_x",
  eventAt,
  status,
  subscriptionId: "sub_x",
});

describe("accounts store", () => {
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(MIGRATION);
  });

  it("makes one account per address, whatever the case of the domain", async () => {
    const first = await accountForSignIn(d1Of(db), " Ann@Example.COM", NOW);
    const again = await accountForSignIn(d1Of(db), "Ann@example.com", NOW + 1);

    expect(again.id).toBe(first.id);
    expect(first.id).toMatch(/^acc_[\w-]{22,}$/u);
    expect(first.email).toBe("Ann@example.com");
    expect(first.subscriptionStatus).toBeNull();
  });

  it("applies a newer subscription event and ignores an older one", async () => {
    const d1 = d1Of(db);
    const { id } = await accountForSignIn(d1, "ann@example.com", NOW);

    const wrote = await applySubscription(d1, {
      ...subscription("active", 200),
      accountId: id,
    });

    const stale = await applySubscription(d1, {
      ...subscription("canceled", 100),
      accountId: id,
    });

    const account = await accountById(d1, id);

    expect(wrote).toBeTruthy();
    expect(stale).toBeFalsy();
    expect(account?.subscriptionStatus).toBe("active");
    expect(account?.stripeEventAt).toBe(200);
    expect(account?.currentPeriodEnd).toBe(1_800_000_000);
  });

  it("applies a second event of the same second", async () => {
    const d1 = d1Of(db);
    const { id } = await accountForSignIn(d1, "ann@example.com", NOW);

    await applySubscription(d1, {
      ...subscription("incomplete", 200),
      accountId: id,
    });

    const wrote = await applySubscription(d1, {
      ...subscription("active", 200),
      accountId: id,
    });

    const account = await accountById(d1, id);

    expect(wrote).toBeTruthy();
    expect(account?.subscriptionStatus).toBe("active");
  });

  it("finds an account by its Stripe customer once linked", async () => {
    const d1 = d1Of(db);
    const { id } = await accountForSignIn(d1, "ann@example.com", NOW);
    const before = await accountByCustomer(d1, "cus_x");

    await linkCustomer(d1, id, "cus_x");

    const linked = await accountByCustomer(d1, "cus_x");

    expect(before).toBeNull();
    expect(linked?.id).toBe(id);
  });

  it("deletes an account", async () => {
    const d1 = d1Of(db);
    const { id } = await accountForSignIn(d1, "ann@example.com", NOW);

    await deleteAccount(d1, id);

    await expect(accountById(d1, id)).resolves.toBeNull();
  });
});
