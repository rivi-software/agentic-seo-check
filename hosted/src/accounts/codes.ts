/**
 * Sign-in codes (issue #229): a six digit code mailed to an address proves it is theirs, with no
 * password. Only the code's SHA-256 is kept, it works for ten minutes, five wrong guesses kill it,
 * and a new one may go out once a minute.
 */
import { PRODUCT_NAME } from "../../../src/brand.js";
import { callerOf } from "../callers.js";
import type { D1Like } from "../d1.js";
import { sha256Hex } from "../secrets.js";
import { normalEmail } from "../site/waitlist.js";
import { accountForSignIn } from "./store.js";
import type { Account } from "./store.js";

export const CODE_MINUTES = 10;

export const CODE_ATTEMPTS = 5;

/** The time before another code may go to the same address, so the form cannot flood it. */
export const RESEND_MS = 60_000;

export interface CodeEnv {
  ACCOUNTS: D1Like;
  EMAIL?: Pick<SendEmail, "send">;
  /** The address the mail comes from, on a domain onboarded to Email Service. */
  ACCOUNTS_FROM?: string;
  /** Codes one IP address may ask for a minute. */
  SIGN_IN_CODES: RateLimit;
}

export type SendResult =
  | "sent"
  | "invalid_email"
  | "too_soon"
  | "limited"
  | "unavailable";

export type CheckResult =
  | { account: Account }
  | { error: "wrong" | "expired" | "locked" };

interface CodeRow {
  code_hash: string;
  attempts: number;
  expires_at: number;
  sent_at: number;
}

/** A code from 000000 to 999999, each as likely as another: values past the last whole multiple are redrawn. */
const newCode = (): string => {
  const limit = 4_294_000_000 - (4_294_000_000 % 1_000_000);
  const draw = new Uint32Array(1);

  do {
    crypto.getRandomValues(draw);
  } while ((draw[0] ?? 0) >= limit);

  return String((draw[0] ?? 0) % 1_000_000).padStart(6, "0");
};

export const sendCode = async (
  env: CodeEnv,
  typed: string,
  ip: string | null,
  now: number
): Promise<SendResult> => {
  const email = normalEmail(typed);

  if (email === null) {
    return "invalid_email";
  }

  if (!env.EMAIL || !env.ACCOUNTS_FROM) {
    return "unavailable";
  }

  // Before anything is written, so a flood from one address leaves no rows.
  const { success } = await env.SIGN_IN_CODES.limit({
    key: callerOf(ip, []).key,
  });

  if (!success) {
    return "limited";
  }

  const kept = await env.ACCOUNTS.prepare(
    "SELECT sent_at FROM sign_in_codes WHERE email = ?"
  )
    .bind(email)
    .first<{ sent_at: number }>();

  if (kept !== null && now - kept.sent_at < RESEND_MS) {
    return "too_soon";
  }

  const code = newCode();

  await env.ACCOUNTS.prepare(
    `INSERT INTO sign_in_codes (email, code_hash, attempts, expires_at, sent_at)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0,
       expires_at = excluded.expires_at, sent_at = excluded.sent_at`
  )
    .bind(email, await sha256Hex(code), now + CODE_MINUTES * 60_000, now)
    .run();

  try {
    await env.EMAIL.send({
      from: { email: env.ACCOUNTS_FROM, name: PRODUCT_NAME },
      to: email,
      subject: `Your ${PRODUCT_NAME} sign-in code`,
      text: `Your sign-in code is ${code}.\n\nIt works for ${CODE_MINUTES} minutes. If you did not ask for it, ignore this email.`,
    });
  } catch {
    // A code no mail carried is no use, and would hold the next try back for a minute.
    await env.ACCOUNTS.prepare("DELETE FROM sign_in_codes WHERE email = ?")
      .bind(email)
      .run();

    return "unavailable";
  }

  return "sent";
};

export const checkCode = async (
  env: CodeEnv,
  typed: string,
  code: string,
  now: number
): Promise<CheckResult> => {
  const email = normalEmail(typed);

  if (email === null) {
    return { error: "wrong" };
  }

  const row = await env.ACCOUNTS.prepare(
    "SELECT code_hash, attempts, expires_at, sent_at FROM sign_in_codes WHERE email = ?"
  )
    .bind(email)
    .first<CodeRow>();

  if (row === null || now > row.expires_at) {
    return { error: "expired" };
  }

  // Before comparing, so a locked code cannot be guessed at any more.
  if (row.attempts >= CODE_ATTEMPTS) {
    return { error: "locked" };
  }

  if ((await sha256Hex(code.trim())) !== row.code_hash) {
    await env.ACCOUNTS.prepare(
      "UPDATE sign_in_codes SET attempts = attempts + 1 WHERE email = ?"
    )
      .bind(email)
      .run();

    return { error: "wrong" };
  }

  // Deleting returns the row only to the one request that gets there first: a code works once.
  const used = await env.ACCOUNTS.prepare(
    "DELETE FROM sign_in_codes WHERE email = ? AND code_hash = ? RETURNING email"
  )
    .bind(email, row.code_hash)
    .first<{ email: string }>();

  if (used === null) {
    return { error: "expired" };
  }

  return { account: await accountForSignIn(env.ACCOUNTS, email, now) };
};
