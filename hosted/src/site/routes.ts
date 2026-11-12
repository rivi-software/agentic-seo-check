import { MARK_SVG } from "../../../src/brand.js";
import { POSTHOG_HOST } from "../../../src/telemetry/posthog.js";
import { VERSION } from "../../../src/version.js";
import { reportError } from "../analytics.js";
import { freshResponse } from "../fresh.js";
/**
 * The routes of the website at agentic-seo.rivi.software (issue #39), which its own Worker serves
 * (worker.ts): the homepage with the audit form, the rules, the form's answer at /audit, and the
 * files a crawler asks for.
 */
import { fontResponse, shareImageResponse } from "../ui/assets.js";
import { OG_IMAGE } from "../ui/og.js";
import { posthogResponse } from "../ui/posthog-script.js";
import { productHuntUpvotes } from "../ui/product-hunt.js";
import { shareImage } from "../ui/share-image.js";
import { answerAudit, formCrawls, formOpen } from "./audit.js";
import type { SiteEnv } from "./audit.js";
import { LLMS_TXT, SITE_JS, SITE_ROBOTS_TXT, SITEMAP_XML } from "./files.js";
import { homePage, notFoundPage } from "./home.js";
import { rulesPage } from "./rules-page.js";
import { sharePage } from "./share-page.js";
import { openShare, shareImageCacheKey } from "./share.js";

const HTML = "text/html; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";

/**
 * Scripts from this site and Turnstile only, and none inline: a report quotes the audited page,
 * and nothing in it may run. Styles are the page's own <style>. The pages send their analytics
 * (issue #57) to PostHog's EU host, the only place besides this site they connect to.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  `connect-src 'self' ${POSTHOG_HOST}`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** A page or a file at an address it keeps from deploy to deploy, which browsers ask for again. */
const file = (
  request: Request,
  body: string,
  contentType: string,
  status = 200
): Promise<Response> =>
  freshResponse(
    request,
    body,
    { "content-type": contentType, ...SECURITY },
    status
  );

/** The address a link put in the field (`/?url=…`). It fills the field only: a GET never audits. */
const prefill = (url: URL): string | undefined =>
  url.searchParams.get("url")?.slice(0, 2048);

/** Where a streamed answer's report goes in the page: text `esc` never lets a page write. */
const REPORT_SLOT = "<!-- agentic-seo-check: report -->";

const ignore = (): void => {
  // A visitor who leaves closes the stream; the crawl still ends, and its record is kept.
};

/**
 * The answer of the audit form: the homepage with the report, never cached and never indexed. A
 * crawl's answer streams: the page up to the report at once, then the rest as the crawl goes.
 */
const audit = async (
  request: Request,
  env: SiteEnv,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<Response> => {
  const [{ status, state, rest }, upvotes] = await Promise.all([
    answerAudit(request, env, ctx),
    productHuntUpvotes(request, ctx),
  ]);

  const page = (report?: string) =>
    homePage({
      open: formOpen(env),
      crawls: formCrawls(env),
      siteKey: env.TURNSTILE_SITE_KEY,
      upvotes,
      ...state,
      ...(report === undefined ? null : { report }),
    });

  const headers = {
    "content-type": HTML,
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
    ...SECURITY,
  };

  if (!rest) {
    return new Response(page(), { status, headers });
  }

  const html = page(REPORT_SLOT);
  const slot = html.indexOf(REPORT_SLOT);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Not awaited: the stream holds what the visitor has not read yet.
  const write = (text: string): void => {
    writer.write(encoder.encode(text)).catch(ignore);
  };

  const stream = async (): Promise<void> => {
    write(html.slice(0, slot));

    try {
      await rest(write);
    } catch (error) {
      // The report could not be drawn (issue #60): the page still ends as a page does.
      void reportError(env, ctx, error, "website:/audit");
    }

    write(html.slice(slot + REPORT_SLOT.length));
    await writer.close();
  };

  ctx.waitUntil(stream().catch(ignore));

  return new Response(readable, { status, headers });
};

/** A share link's page, and its image with `.png` after it (issue #54). */
const SHARE_ROUTE = /^\/share\/(?<token>[\w-]+\.[\w-]{22})(?<png>\.png)?$/u;

/**
 * A shared result's page or image, when one of the keys signed it, and the 404 page otherwise.
 * The page is kept out of search. The image of a result never changes within a version, so it is
 * drawn once and kept in the Cache API of the Cloudflare location that drew it.
 */
const share = async (
  request: Request,
  env: SiteEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  token: string,
  png: boolean
): Promise<Response> => {
  const result = await openShare(env, token);

  if (!result) {
    return file(request, notFoundPage(), HTML, 404);
  }

  if (!png) {
    const page = await file(request, sharePage({ result, token }), HTML);
    page.headers.set("x-robots-tag", "noindex");

    return page;
  }

  // The cache keeps GET answers, and a HEAD asks for the same image without its body. The key
  // names the version, so a deploy that changes the card draws it again.
  const key = new Request(shareImageCacheKey(request.url, VERSION), {
    method: "GET",
  });

  const cache = await caches.open("share-images");
  const cached = await cache.match(key);

  const image =
    cached ??
    new Response(await shareImage(result), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });

  if (!cached) {
    ctx.waitUntil(cache.put(key, image.clone()));
  }

  return request.method === "HEAD"
    ? new Response(null, { headers: image.headers })
    : image;
};

export const siteRoute = (
  request: Request,
  env: SiteEnv,
  ctx: Pick<ExecutionContext, "waitUntil">
): Response | Promise<Response> => {
  const url = new URL(request.url);
  const read = request.method === "GET" || request.method === "HEAD";

  if (url.pathname === "/audit") {
    if (request.method === "POST") {
      return audit(request, env, ctx);
    }

    // A report has no address of its own: /audit opened as a link goes to the form.
    return read
      ? new Response(null, { status: 303, headers: { location: "/" } })
      : new Response("Method not allowed.\n", {
          status: 405,
          headers: { allow: "GET, HEAD, POST" },
        });
  }

  if (!read) {
    return new Response("Method not allowed.\n", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  const shared = SHARE_ROUTE.exec(url.pathname)?.groups;

  if (shared?.token) {
    return share(request, env, ctx, shared.token, Boolean(shared.png));
  }

  switch (url.pathname) {
    case "/": {
      return productHuntUpvotes(request, ctx).then((upvotes) =>
        file(
          request,
          homePage({
            open: formOpen(env),
            crawls: formCrawls(env),
            siteKey: env.TURNSTILE_SITE_KEY,
            url: prefill(url),
            upvotes,
          }),
          HTML
        )
      );
    }

    case "/rules": {
      return file(request, rulesPage(), HTML);
    }

    case "/robots.txt": {
      return file(request, SITE_ROBOTS_TXT, TEXT);
    }

    case "/sitemap.xml": {
      return file(request, SITEMAP_XML, "application/xml; charset=utf-8");
    }

    case "/llms.txt": {
      return file(request, LLMS_TXT, "text/markdown; charset=utf-8");
    }

    case "/site.js": {
      return file(request, SITE_JS, "text/javascript; charset=utf-8");
    }

    case "/ph.js": {
      return (
        posthogResponse(request, env.POSTHOG_HOST) ??
        file(request, notFoundPage(), HTML, 404)
      );
    }

    case "/favicon.svg": {
      return file(request, MARK_SVG, "image/svg+xml");
    }

    case OG_IMAGE.path: {
      return shareImageResponse(request, "site");
    }

    default: {
      return (
        fontResponse(request, url.pathname) ??
        file(request, notFoundPage(), HTML, 404)
      );
    }
  }
};
