/**
 * The website at agentic-seo.org (issue #39) as a Worker of its own, agentic-seo-check-site
 * (wrangler.site.jsonc), beside the MCP server's, which takes its own paths on the same hostname
 * (issue #168): both deploy with each change to main that reaches them, the MCP server first
 * (deploy-hosted.yml). The two share their limits: the same rate limiting namespaces, and the MCP
 * Worker's HostedState object for the day's counts.
 */
import { onCaughtError } from "../../../src/core/errors.js";
import { hearCaughtError, inRequest, reportError } from "../analytics.js";
import type { ErrorRoute } from "../analytics.js";
import type { SiteEnv } from "./audit.js";
import { siteRoute } from "./routes.js";
import { RULES_PREFIX } from "./rule-info.js";

// The errors the core catches in the form's audits reach error tracking, with their run (issue #96).
onCaughtError(hearCaughtError);

/** The paths an error's event may name (issue #60); any other is `other`. */
const KNOWN_PATHS = new Set([
  "/",
  "/audit",
  "/rules",
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
  "/site.js",
  "/ph.js",
  "/favicon.svg",
]);

/** Where a request went, as an error's event names it: never its address, nor a share link's result. */
const errorRoute = (request: Request): ErrorRoute => {
  const { pathname } = new URL(request.url);

  if (pathname.startsWith("/share/")) {
    return "website:/share/:result";
  }

  if (pathname.startsWith(RULES_PREFIX)) {
    return "website:/rules/:rule";
  }

  return `website:${KNOWN_PATHS.has(pathname) ? pathname : "other"}`;
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await inRequest({ env, ctx, route: errorRoute(request) }, () =>
        siteRoute(request, env, ctx)
      );
    } catch (error) {
      // Workers Logs keep errors only: the message, never the request's body or headers.
      console.error(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`
      );
      void reportError(env, ctx, error, errorRoute(request), {
        handled: false,
      });

      return new Response("Something went wrong on the website.\n", {
        status: 500,
      });
    }
  },
} satisfies ExportedHandler<SiteEnv>;
