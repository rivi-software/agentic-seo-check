/**
 * The routes of the premium waitlist (issue #232): its page and form at /premium, and the pages the
 * links in its emails open. Apart from routes.ts, so that they load in Node for their tests.
 */
import { PREMIUM_PATH, premiumPage } from "./premium-page.js";
import { file, HTML, methodNotAllowed, secretPage } from "./respond.js";
import { followLink, signUp, TOKEN, waitlistOpen } from "./waitlist.js";
import type { PremiumView, WaitlistSiteEnv } from "./waitlist.js";

/** A link from a waitlist email: the secret confirms or removes an address. */
const WAITLIST_LINK =
  /^\/premium\/(?<action>confirm|remove)\/(?<token>[^/]{1,64})$/u;

/**
 * The waitlist's page. The form as a GET shows it is kept as any page is; every other answer
 * (a sent form, a link's page) is a secret page, never cached and never indexed.
 */
const waitlistPage = (
  request: Request,
  env: WaitlistSiteEnv,
  status: number,
  page: PremiumView
): Response | Promise<Response> => {
  const body = premiumPage({
    page,
    open: waitlistOpen(env),
    siteKey: env.TURNSTILE_SITE_KEY,
  });

  return page.view === "form" && request.method !== "POST"
    ? file(request, body, HTML)
    : secretPage(request, body, status);
};

/** The waitlist's routes, or null for any other path. */
export const waitlistRoute = (
  request: Request,
  env: WaitlistSiteEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  path: string
): Response | Promise<Response> | null => {
  const link = WAITLIST_LINK.exec(path)?.groups;

  if (path !== PREMIUM_PATH && !link) {
    return null;
  }

  const post = request.method === "POST";

  if (!post && request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD, POST");
  }

  if (!(link?.action && link.token)) {
    return post
      ? signUp(request, env, ctx).then(({ status, page }) =>
          waitlistPage(request, env, status, page)
        )
      : waitlistPage(request, env, 200, { view: "form" });
  }

  const action = link.action === "remove" ? "remove" : "confirm";

  if (!TOKEN.test(link.token)) {
    return waitlistPage(request, env, 404, { view: "expired" });
  }

  // Opening the link only shows the button: mail scanners open every link in a message.
  return post
    ? followLink(env, action, link.token).then(({ status, page }) =>
        waitlistPage(request, env, status, page)
      )
    : waitlistPage(request, env, 200, { view: action, token: link.token });
};
