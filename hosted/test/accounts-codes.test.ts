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
  FAILURES_A_DAY,
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

const DAY_MS = 86_400_000;

/** Sends a code at `at` and guesses wrong `times`, returning the code that went out. */
const failWith = async (at: number, times: number): Promise<string> => {
  await expect(sendCode(env(), "me@example.com", null, at)).resolves.toBe(
    "sent"
  );

  const code = lastCode();
  const wrong = code === "000000" ? "000001" : "000000";

  for (let guess = 0; guess < times; guess += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one guess after another, as a person types
    await checkCode(env(), "me@example.com", wrong, at + 1);
  }

  return code;
};

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

    it("gives parallel wrong guesses no more than the attempts", async () => {
      await sendCode(env(), "me@example.com", null, NOW);

      const code = lastCode();
      const wrong = code === "000000" ? "000001" : "000000";

      const answers = await Promise.all(
        Array.from({ length: CODE_ATTEMPTS * 3 }, () =>
          checkCode(env(), "me@example.com", wrong, NOW + 1)
        )
      );

      expect(
        answers.filter((a) => "error" in a && a.error === "wrong")
      ).toHaveLength(CODE_ATTEMPTS);
      await expect(
        checkCode(env(), "me@example.com", code, NOW + 2)
      ).resolves.toStrictEqual({ error: "locked" });
    });

    describe("across new codes", () => {
      it("locks the address for the day after FAILURES_A_DAY wrong guesses, however many codes went out", async () => {
        // Wrong guesses per code, adding up to the day's cap; the last code keeps attempts of its
        // own, so only the day's cap can lock it.
        const pattern = [5, 5, 5, 3, 2];

        expect(pattern.reduce((sum, each) => sum + each)).toBe(FAILURES_A_DAY);

        let last = "";

        for (const [index, times] of pattern.entries()) {
          // oxlint-disable-next-line no-await-in-loop -- each code after the last one's minute
          last = await failWith(NOW + index * RESEND_MS, times);
        }

        await expect(
          checkCode(
            env(),
            "me@example.com",
            last,
            NOW + pattern.length * RESEND_MS
          )
        ).resolves.toStrictEqual({ error: "locked" });
        await expect(
          sendCode(env(), "me@example.com", null, NOW + DAY_MS / 24)
        ).resolves.toBe("limited");
      });

      it("opens again on the next UTC day", async () => {
        for (
          let index = 0;
          index < FAILURES_A_DAY / CODE_ATTEMPTS;
          index += 1
        ) {
          // oxlint-disable-next-line no-await-in-loop -- each code after the last one's minute
          await failWith(NOW + index * RESEND_MS, CODE_ATTEMPTS);
        }

        const tomorrow = NOW + DAY_MS;
        const code = await failWith(tomorrow, 0);

        await expect(
          checkCode(env(), "me@example.com", code, tomorrow + 1)
        ).resolves.toMatchObject({ account: { email: "me@example.com" } });
      });

      it("keeps the day's count when a mail fails", async () => {
        const codes = FAILURES_A_DAY / CODE_ATTEMPTS;

        for (let index = 0; index < codes - 1; index += 1) {
          // oxlint-disable-next-line no-await-in-loop -- each code after the last one's minute
          await failWith(NOW + index * RESEND_MS, CODE_ATTEMPTS);
        }

        await failWith(NOW + (codes - 1) * RESEND_MS, CODE_ATTEMPTS - 1);

        const later = NOW + (codes + 1) * RESEND_MS;

        await expect(
          sendCode(
            {
              ...env(),
              EMAIL: { send: () => Promise.reject(new Error("mail down")) },
            },
            "me@example.com",
            null,
            later
          )
        ).resolves.toBe("unavailable");

        // One more wrong guess makes the day's cap, so even the right code is refused.
        const code = await failWith(later + 1, 1);

        await expect(
          checkCode(env(), "me@example.com", code, later + 2)
        ).resolves.toStrictEqual({ error: "locked" });
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
