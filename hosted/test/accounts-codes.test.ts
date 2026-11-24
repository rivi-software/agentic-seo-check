/**
 * Sign-in codes (issue #229) in Node: the real migration in SQLite, Email Service and the rate
 * limiter in memory.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  checkCode,
  CODE_ATTEMPTS,
  CODE_MINUTES,
  RESEND_MS,
  sendCode,
} from "../src/accounts/codes.ts";
import type { CodeEnv } from "../src/accounts/codes.ts";
import { d1Of } from "./helpers/d1.ts";

const NOW = Date.UTC(2026, 10, 24, 12);

// A type-level check: `pnpm run hosted:check` fails if D1Database is not a D1Like.
const takesRealD1 = (d1: D1Database): CodeEnv["ACCOUNTS"] => d1;

let db: DatabaseSync;
let texts: string[];
let subjects: string[];
let limited: boolean;

const env = (): CodeEnv => ({
  ACCOUNTS: d1Of(db),
  ACCOUNTS_FROM: "premium@rivi.software",
  EMAIL: {
    send: (message) => {
      if ("subject" in message) {
        subjects.push(message.subject);
        texts.push(message.text ?? "");
      }

      return Promise.resolve({ messageId: "id" });
    },
  },
  SIGN_IN_CODES: { limit: () => Promise.resolve({ success: !limited }) },
});

const lastCode = (): string => /\b\d{6}\b/u.exec(texts.at(-1) ?? "")?.[0] ?? "";

describe("sign-in codes", () => {
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(
      readFileSync(
        new URL("../migrations-accounts/0001_accounts.sql", import.meta.url),
        "utf-8"
      )
    );
    texts = [];
    subjects = [];
    limited = false;
  });

  describe(sendCode, () => {
    it("sends one mail with a six digit code and keeps only its hash", async () => {
      await expect(
        sendCode(env(), "me@Example.com", "1.2.3.4", NOW)
      ).resolves.toBe("sent");
      expect(texts).toHaveLength(1);

      const code = lastCode();

      expect(code).toMatch(/^\d{6}$/u);
      expect(
        JSON.stringify(db.prepare("SELECT * FROM sign_in_codes").all())
      ).not.toContain(code);
    });

    it("names the sign-in code and its minutes in the mail", async () => {
      await sendCode(env(), "me@example.com", null, NOW);

      expect(subjects[0]).toContain("sign-in code");
      expect(texts[0]).toContain(`${CODE_MINUTES} minutes`);
    });

    it("answers too_soon within a minute and sends nothing", async () => {
      await sendCode(env(), "me@example.com", null, NOW);

      await expect(
        sendCode(env(), "me@example.com", null, NOW + RESEND_MS - 1)
      ).resolves.toBe("too_soon");
      expect(texts).toHaveLength(1);
      await expect(
        sendCode(env(), "me@example.com", null, NOW + RESEND_MS)
      ).resolves.toBe("sent");
    });

    it("refuses a bad address, a limited caller and a missing mail binding", async () => {
      await expect(sendCode(env(), "nope", null, NOW)).resolves.toBe(
        "invalid_email"
      );
      limited = true;
      await expect(sendCode(env(), "me@example.com", null, NOW)).resolves.toBe(
        "limited"
      );
      expect(db.prepare("SELECT * FROM sign_in_codes").all()).toHaveLength(0);
    });

    it("answers unavailable without the mail binding", async () => {
      await expect(
        sendCode({ ...env(), EMAIL: undefined }, "me@example.com", null, NOW)
      ).resolves.toBe("unavailable");
    });
  });

  describe(checkCode, () => {
    it("returns the account once, then answers expired", async () => {
      await sendCode(env(), "me@example.com", null, NOW);

      const code = lastCode();
      const result = await checkCode(env(), "me@example.com", code, NOW + 1000);

      expect(result).toMatchObject({ account: { email: "me@example.com" } });
      await expect(
        checkCode(env(), "me@example.com", code, NOW + 2000)
      ).resolves.toStrictEqual({
        error: "expired",
      });
    });

    it("answers wrong, then locked after the attempts", async () => {
      await sendCode(env(), "me@example.com", null, NOW);

      const code = lastCode();
      const wrong = code === "000000" ? "000001" : "000000";

      const guesses = await Promise.all(
        Array.from({ length: CODE_ATTEMPTS }, () =>
          checkCode(env(), "me@example.com", wrong, NOW + 1)
        )
      );

      expect(guesses).toStrictEqual(
        Array.from({ length: CODE_ATTEMPTS }, () => ({ error: "wrong" }))
      );

      await expect(
        checkCode(env(), "me@example.com", code, NOW + 2)
      ).resolves.toStrictEqual({
        error: "locked",
      });
    });

    it("answers expired after the minutes", async () => {
      await sendCode(env(), "me@example.com", null, NOW);

      await expect(
        checkCode(
          env(),
          "me@example.com",
          lastCode(),
          NOW + CODE_MINUTES * 60_000 + 1
        )
      ).resolves.toStrictEqual({ error: "expired" });
    });
  });

  describe("types", () => {
    it("takes the real D1Database", () => {
      expect(takesRealD1).toBeTypeOf("function");
    });
  });
});
