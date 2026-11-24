/**
 * What the website's forms share (the audit form, audit.ts, and the premium waitlist, waitlist.ts):
 * the check that the form came from this site, its body read within a cap, its text fields, and
 * Cloudflare Turnstile's check that a person sent it.
 */
import { z } from "zod";

export interface TurnstileEnv {
  /** Turnstile's public site key (wrangler.site.jsonc); empty until the widget exists. */
  TURNSTILE_SITE_KEY: string;
  /** Turnstile's secret key, a Worker secret (`wrangler secret put TURNSTILE_SECRET_KEY`). */
  TURNSTILE_SECRET_KEY?: string;
}

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The site's forms are small; a larger body is not one of them. */
const MAX_FORM_BYTES = 16_384;

/** A browser names the page a form was sent from: only this site's own forms are answered. */
export const fromThisSite = (request: Request): boolean => {
  const origin = request.headers.get("origin");

  return !origin || origin === new URL(request.url).origin;
};

/** The field `name` of a form, when it is text. */
export const field = (form: FormData, name: string): string => {
  const value = z.string().safeParse(form.get(name));

  return value.success ? value.data.trim() : "";
};

/**
 * Reads the form, or null for a body that is not one. A browser sends a form with its length; a
 * body without a length, or with one that is not a number, could be any size, and reading it
 * would buffer all of it before Turnstile or a limit has had a say.
 */
export const readForm = async (request: Request): Promise<FormData | null> => {
  const length = request.headers.get("content-length");

  if (
    length === null ||
    !/^\d+$/u.test(length) ||
    Number(length) > MAX_FORM_BYTES
  ) {
    return null;
  }

  try {
    return await request.formData();
  } catch {
    return null;
  }
};

const Siteverify = z.object({ success: z.boolean() });

/** Asks Turnstile whether the form's token is one it gave this site's forms, and has not been used. */
export const personSent = async (
  env: TurnstileEnv,
  form: FormData,
  ip: string | null
): Promise<boolean> => {
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY ?? "",
    response: field(form, "cf-turnstile-response"),
  });

  if (ip) {
    body.set("remoteip", ip);
  }

  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    const answer = Siteverify.safeParse(await res.json());

    return res.ok && answer.success && answer.data.success;
  } catch {
    // Turnstile not answering is not a person passing the check.
    return false;
  }
};
