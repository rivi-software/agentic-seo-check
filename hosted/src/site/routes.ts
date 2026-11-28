import { findRule } from "../../../src/core/rules/index.js";
import { VERSION } from "../../../src/version.js";
import { reportError } from "../analytics.js";
import { FORMER_SITE_HOST, movedToOrigin } from "../limits.js";
import { readReport } from "../shared-reports.js";
/**
 * The routes of the website at agentic-seo.org (issues #39 and #168), which its own Worker serves
 * (worker.ts): the homepage with the audit form, the rules, the form's answer at /audit and the
 * files a crawler asks for. The fixed files the pages load (the script, the fonts, the share
 * images, posthog-js, pdfmake) are static assets, which Cloudflare serves before this Worker runs
 * (scripts/assets.ts, issue #202). The MCP server's own paths on the hostname go to its Worker.
 */
import { productHuntUpvotes } from "../ui/product-hunt.js";
import { shareImage } from "../ui/share-image.js";
import { accountRoute } from "./account-routes.js";
import { answerAudit, formCrawls, formOpen } from "./audit.js";
import type { SiteEnv } from "./audit.js";
import { LLMS_TXT, SITE_ROBOTS_TXT, SITEMAP_XML } from "./files.js";
import { homePage, notFoundPage } from "./home.js";
import {
  file,
  HTML,
  methodNotAllowed,
  SECURITY,
  secretPage,
} from "./respond.js";
import { RULES_PREFIX } from "./rule-info.js";
import { rulePage } from "./rule-page.js";
import { rulesPage } from "./rules-page.js";
import { shareUpload } from "./share-api.js";
import { sharePage } from "./share-page.js";
import { openShare, shareImageCacheKey } from "./share.js";
import { sharedReportPage } from "./shared-page.js";
import { waitlistRoute } from "./waitlist-routes.js";

const TEXT = "text/plain; charset=utf-8";

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

/** A rule's page (issue #171), at a path that names a rule, or null for any other path. */
const ruleResponse = (
  request: Request,
  path: string
): Promise<Response> | null => {
  const rule = path.startsWith(RULES_PREFIX)
    ? findRule(path.slice(RULES_PREFIX.length))
    : undefined;

  return rule ? file(request, rulePage(rule), HTML) : null;
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

/** A shared report's page (shared-reports.ts): the id is 128 random bits. */
const REPORT_ROUTE = /^\/report\/(?<id>[\w-]{22})$/u;

/**
 * A shared report, or the 404 page once it has expired. Its address is the secret, so the page
 * sends no referrer (a link in the report would hand the address to the audited site), is never
 * cached, and is kept out of search.
 */
const sharedReport = async (
  request: Request,
  env: SiteEnv,
  id: string
): Promise<Response> => {
  const stored = env.SHARED_REPORTS
    ? await readReport(env.SHARED_REPORTS, id)
    : null;

  const body = stored ? sharedReportPage(stored) : notFoundPage();

  return secretPage(request, body, stored ? 200 : 404);
};

/** An upload of a report to share at /api/share, or a shared report's page; null for any other path. */
const sharedRoute = (
  request: Request,
  env: SiteEnv,
  path: string
): Promise<Response> | Response | null => {
  if (path === "/api/share") {
    return request.method === "POST"
      ? shareUpload(request, env)
      : methodNotAllowed("POST");
  }

  const id = REPORT_ROUTE.exec(path)?.groups?.id;

  if (!id) {
    return null;
  }

  return request.method === "GET" || request.method === "HEAD"
    ? sharedReport(request, env, id)
    : methodNotAllowed("GET, HEAD");
};

export const siteRoute = (
  request: Request,
  env: SiteEnv,
  ctx: Pick<ExecutionContext, "waitUntil">
): Response | Promise<Response> => {
  const url = new URL(request.url);
  const read = request.method === "GET" || request.method === "HEAD";

  // The hostname before issue #168: links, share links and search results keep working.
  if (url.hostname === FORMER_SITE_HOST) {
    return movedToOrigin(request);
  }

  if (url.pathname === "/audit") {
    if (request.method === "POST") {
      return audit(request, env, ctx);
    }

    // A report has no address of its own: /audit opened as a link goes to the form.
    return read
      ? new Response(null, { status: 303, headers: { location: "/" } })
      : methodNotAllowed("GET, HEAD, POST");
  }

  const waitlist = waitlistRoute(request, env, ctx, url.pathname);

  if (waitlist) {
    return waitlist;
  }

  const account = accountRoute(request, env, ctx, url.pathname);

  if (account) {
    return account;
  }

  const sharing = sharedRoute(request, env, url.pathname);

  if (sharing) {
    return sharing;
  }

  if (!read) {
    return methodNotAllowed("GET, HEAD");
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

    default: {
      // No page and no static asset.
      return (
        ruleResponse(request, url.pathname) ??
        file(request, notFoundPage(), HTML, 404)
      );
    }
  }
};
