/**
 * The audit form's answer (POST /audit, issue #39): the SEO and AEO audits of one page, run as a
 * hosted tool call is. Cloudflare Turnstile checks that a person sent the form, the hosted limits
 * count the run for its address, and every request goes through the hosted gate. The answer is the
 * homepage with the report, or with the reason there is none. Nothing of it is stored.
 */
import { z } from "zod";

import { auditAeoUrl } from "../../../src/core/aeo/audit.js";
import { auditUrl } from "../../../src/core/audit.js";
import { RequestRefusedError } from "../../../src/core/fetch.js";
import type { FetchOptions } from "../../../src/core/fetch.js";
import {
  HOSTED_LIMITS,
  hostedGate,
  hostedUrlProblem,
} from "../../../src/core/hosted.js";
import type { HostedCall } from "../../../src/mcp.js";
import { callerOf } from "../callers.js";
import { hostedProfile, USER_AGENT } from "../limits.js";
import type { LimitsEnv } from "../limits.js";
import type { HomeState } from "./home.js";
import { renderReport } from "./report.js";

/** The Worker's bindings and variables the audit form uses, beside the limits'. */
export interface SiteEnv extends LimitsEnv {
  /** Turnstile's public site key (wrangler.jsonc); empty until the widget exists. */
  TURNSTILE_SITE_KEY: string;
  /** Turnstile's secret key, a Worker secret (`wrangler secret put TURNSTILE_SECRET_KEY`). */
  TURNSTILE_SECRET_KEY?: string;
}

/** The name the record of a run has where a tool call's has the tool. */
export const WEB_AUDIT = "web_audit_page";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** A form with one URL in it is small; a larger body is not the form. */
const MAX_FORM_BYTES = 16_384;

const MAX_URL_CHARS = 2048;

/** The form is on when Turnstile is set up and the server is not paused: it never runs unchecked. */
export const formOpen = (env: SiteEnv): boolean =>
  env.MODE !== "closed" &&
  Boolean(env.TURNSTILE_SITE_KEY) &&
  Boolean(env.TURNSTILE_SECRET_KEY);

const Siteverify = z.object({ success: z.boolean() });

/** Asks Turnstile whether `token` is one it gave this site's form, and has not been used. */
const personSent = async (
  env: SiteEnv,
  token: string,
  ip: string | null
): Promise<boolean> => {
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY ?? "",
    response: token,
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

/** What the form's answer shows, and the HTTP status it comes with. */
export interface AuditAnswer {
  status: number;
  state: Pick<HomeState, "url" | "error" | "report">;
}

const refuse = (status: number, error: string, url?: string): AuditAnswer => ({
  status,
  state: { url, error },
});

/** The address as typed, with https:// before a bare hostname, or null when it is not a URL. */
const targetOf = (typed: string): URL | null => {
  const address = /^[a-z][a-z0-9+.-]*:\/\//iu.test(typed)
    ? typed
    : `https://${typed}`;

  return URL.canParse(address) ? new URL(address) : null;
};

/** The two audits of `target`, as a report. */
const runAudits = async (
  target: string,
  fetchOptions: FetchOptions
): Promise<string> => {
  const [seo, aeo] = await Promise.all([
    auditUrl(target, { fetch: fetchOptions }),
    auditAeoUrl(target, { fetch: fetchOptions }),
  ]);

  return renderReport(seo, aeo);
};

/** The field `name` of a form, when it is text. */
const field = (form: FormData, name: string): string => {
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

/** Answers the audit form: checks it, runs the audits within the hosted limits, renders the report. */
export const answerAudit = async (
  request: Request,
  env: SiteEnv,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<AuditAnswer> => {
  // A browser names the page a form was sent from: only this site's own form is answered.
  const origin = request.headers.get("origin");

  if (origin && origin !== new URL(request.url).origin) {
    return refuse(403, "The audit form answers this site's own page only.");
  }

  const form = await readForm(request);

  if (!form) {
    return refuse(400, "That was not the audit form. Enter an address below.");
  }

  const typed = field(form, "url");

  if (!typed) {
    return refuse(
      400,
      "Enter the address of a page, such as https://example.com/pricing."
    );
  }

  const target =
    typed.length > MAX_URL_CHARS ? null : targetOf(typed.slice(0, 4096));

  if (!target) {
    return refuse(
      400,
      "That is not an address the audit can request. Enter one such as https://example.com/pricing.",
      typed.slice(0, MAX_URL_CHARS)
    );
  }

  const problem = hostedUrlProblem(target);

  if (problem) {
    return refuse(400, problem, typed);
  }

  if (!formOpen(env)) {
    return refuse(503, "The page audit is switched off at the moment.", typed);
  }

  const ip = request.headers.get("cf-connecting-ip");

  if (!(await personSent(env, field(form, "cf-turnstile-response"), ip))) {
    return refuse(
      403,
      "The check that keeps bots out did not pass, or it ran out. Run the audit again.",
      typed
    );
  }

  const info = {
    tool: WEB_AUDIT,
    fetches: true,
    crawl: false,
    host: target.hostname,
  };

  let call: HostedCall;

  try {
    // A browser is never claude.ai's or ChatGPT's connector, so no platform ranges apply.
    call = await hostedProfile(env, ctx, callerOf(ip, [])).startCall(info);
  } catch (error) {
    return refuse(
      429,
      error instanceof Error ? error.message : String(error),
      typed
    );
  }

  try {
    const report = await runAudits(target.href, {
      userAgent: USER_AGENT,
      maxBodyBytes: HOSTED_LIMITS.maxBodyBytes,
      timeoutMs: HOSTED_LIMITS.timeoutMs,
      gate: hostedGate(call.gate),
    });

    call.end?.({ outcome: "ok", pages: 1 });

    return { status: 200, state: { url: target.href, report } };
  } catch (error) {
    const refused = error instanceof RequestRefusedError;
    call.end?.({ outcome: refused ? "refused" : "error", pages: 0 });

    return refuse(
      502,
      refused
        ? error.message
        : `The audit of ${target.hostname} failed: ${error instanceof Error ? error.message : String(error)}`,
      typed
    );
  }
};
