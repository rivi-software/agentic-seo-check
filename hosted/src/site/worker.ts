/**
 * The website at agentic-seo.rivi.software (issue #39) as a Worker of its own,
 * agentic-seo-check-site (wrangler.site.jsonc), beside the MCP server's: both deploy with each
 * change to main that reaches them, the MCP server first (deploy-hosted.yml). The two share their
 * limits: the same rate limiting namespaces, and the MCP Worker's HostedState object for the day's
 * counts.
 */
import { reportError } from "../analytics.js";
import type { ErrorRoute } from "../analytics.js";
import type { SiteEnv } from "./audit.js";
import { siteRoute } from "./routes.js";

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

  return `website:${KNOWN_PATHS.has(pathname) ? pathname : "other"}`;
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await siteRoute(request, env, ctx);
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
