/**
 * The hosted MCP server of Agentic SEO Check (issue #35): a stateless Worker that answers MCP over
 * Streamable HTTP at /mcp with the hosted tools of `createMcpServer`, and serves the pages that say
 * how to use it and what its requests are. The project's website is a Worker of its own
 * (src/site/worker.ts), so it deploys apart from the server.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { onCaughtError } from "../../src/core/errors.js";
import { HOSTED_LIMITS } from "../../src/core/hosted.js";
import { HOSTED_TOOLS } from "../../src/mcp-hosted.js";
import { createMcpServer } from "../../src/mcp.js";
import { instrumentTransport } from "../../src/telemetry/mcp.js";
import {
  hearCaughtError,
  hostedAnalytics,
  inRequest,
  reportError,
  reportTask,
} from "./analytics.js";
import type { ErrorRoute } from "./analytics.js";
import {
  callerOf,
  openAiRangesReader,
  refreshOpenAiRanges,
} from "./callers.js";
import { FORMER_HOST, hostedProfile, ORIGIN } from "./limits.js";
import {
  crawlerPage,
  FAVICON_SVG,
  landingPage,
  notFoundPage,
  ROBOTS_TXT,
} from "./pages.js";
import { DIRECTORY_PATH, directoryResponse, signingKeys } from "./signing.js";
import { SITE_JS } from "./site/files.js";
import { fontResponse, shareImageResponse } from "./ui/assets.js";
import { OG_IMAGE } from "./ui/og.js";
import { posthogResponse } from "./ui/posthog-script.js";

export { HostedState } from "./state.js";

// The errors the core catches and turns into findings reach error tracking (issue #93).
onCaughtError(hearCaughtError);

/** Open to every origin, without credentials, so browser clients such as the MCP Inspector connect. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

const PREFLIGHT = {
  ...CORS,
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-max-age": "86400",
};

/** OpenAI's ranges as this isolate reads them: from the Durable Object at most once an hour. */
const openAiRanges = openAiRangesReader();

/**
 * One MCP request: stateless, so every POST gets its own server and transport, and the answer is
 * JSON. The `Mcp-Session-Id` an `initialize` is answered with is a token for the analytics alone
 * (analytics.ts), which any request can read without the server keeping anything. There is no
 * session to resume or end, so GET and DELETE answer 405, as the protocol allows.
 */
const handleMcp = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("This MCP server takes POST requests only.\n", {
      status: 405,
      headers: { ...CORS, allow: "POST, OPTIONS" },
    });
  }

  const report = reportTask(env, ctx, "server:/mcp");

  const caller = callerOf(
    request.headers.get("cf-connecting-ip"),
    await openAiRanges(env, ctx, report)
  );

  const tracking = hostedAnalytics(
    env,
    ctx,
    caller,
    request.headers.get("mcp-session-id")
  );

  const server = createMcpServer({
    hosted: {
      ...hostedProfile(env, ctx, caller, {
        observe: tracking?.observe,
        report,
      }),
      connection: tracking?.connection,
    },
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    // The schemas cap inline HTML at 2,000,000 characters; this caps the whole request before it is
    // parsed.
    maxRequestBodySize: HOSTED_LIMITS.maxRequestBytes,
  });

  await server.connect(transport);

  if (tracking) {
    instrumentTransport(transport, tracking.analytics, HOSTED_TOOLS);
  }

  try {
    const response = await transport.handleRequest(request);
    const headers = new Headers(response.headers);

    for (const [name, value] of Object.entries(CORS)) {
      headers.set(name, value);
    }

    // The client sends the session's token back with each request, so its calls share a session.
    const session = tracking?.sessionToken();

    if (session && response.ok) {
      headers.set("mcp-session-id", session);
    }

    return new Response(response.body, { status: response.status, headers });
  } finally {
    ctx.waitUntil(server.close());
  }
};

const page = (
  request: Request,
  body: string,
  contentType: string,
  status = 200
): Response =>
  new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });

const HTML = "text/html; charset=utf-8";

/** The key directory of Web Bot Auth, or not found while there is no key to list. */
const keyDirectory = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> => {
  const report = reportTask(env, ctx, `server:${DIRECTORY_PATH}`);

  const keys = await signingKeys(env.WEB_BOT_AUTH_KEYS, (error) =>
    report(error, "signing_keys")
  );

  return keys.length > 0
    ? directoryResponse(keys, request)
    : page(request, notFoundPage(), HTML, 404);
};

const route = (request: Request, env: Env, ctx: ExecutionContext) => {
  const { hostname, pathname, search } = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: PREFLIGHT });
  }

  if (pathname === "/mcp") {
    return handleMcp(request, env, ctx);
  }

  // The pages, the User-Agent's link included, live on the current hostname only.
  if (hostname === FORMER_HOST) {
    return new Response(null, {
      status: 301,
      headers: { location: `${ORIGIN}${pathname}${search}` },
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.\n", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  switch (pathname) {
    case "/": {
      return page(request, landingPage(env), HTML);
    }

    case "/crawler": {
      return page(request, crawlerPage(), HTML);
    }

    case "/robots.txt": {
      return page(request, ROBOTS_TXT, "text/plain; charset=utf-8");
    }

    case "/favicon.svg": {
      return page(request, FAVICON_SVG, "image/svg+xml");
    }

    // The pages share the website's script and fonts.
    case "/site.js": {
      return page(request, SITE_JS, "text/javascript; charset=utf-8");
    }

    case "/ph.js": {
      return (
        posthogResponse(request, env.POSTHOG_HOST) ??
        page(request, notFoundPage(), HTML, 404)
      );
    }

    case OG_IMAGE.path: {
      return shareImageResponse(request, "server");
    }

    case DIRECTORY_PATH: {
      return keyDirectory(request, env, ctx);
    }

    case "/.well-known/openai-apps-challenge": {
      return env.OPENAI_APPS_CHALLENGE
        ? page(request, env.OPENAI_APPS_CHALLENGE, "text/plain; charset=utf-8")
        : page(request, notFoundPage(), HTML, 404);
    }

    default: {
      return (
        fontResponse(request, pathname) ??
        page(request, notFoundPage(), HTML, 404)
      );
    }
  }
};

/** The paths an error's event may name (issue #60); any other is `other`. */
const KNOWN_PATHS = new Set([
  "/",
  "/mcp",
  "/crawler",
  "/robots.txt",
  "/site.js",
  "/ph.js",
  "/favicon.svg",
  DIRECTORY_PATH,
]);

/** Where a request went, as an error's event names it: never its address. */
const errorRoute = (request: Request): ErrorRoute => {
  const { pathname } = new URL(request.url);

  return `server:${KNOWN_PATHS.has(pathname) ? pathname : "other"}`;
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await inRequest({ env, ctx, route: errorRoute(request) }, () =>
        route(request, env, ctx)
      );
    } catch (error) {
      // Workers Logs keep errors only: the message, never the request's body or headers.
      console.error(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`
      );
      // In the caller's session, when its request sent the token of one.
      void reportError(env, ctx, error, errorRoute(request), {
        handled: false,
        session: request.headers.get("mcp-session-id"),
      });

      return new Response("Something went wrong on the hosted server.\n", {
        status: 500,
        headers: CORS,
      });
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    try {
      await refreshOpenAiRanges(env);
    } catch (error) {
      // The run still fails, as Workers Logs show it; error tracking hears it first (issue #93).
      await reportError(env, ctx, error, "server:cron", {
        properties: { task: "openai_ranges" },
      });

      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
