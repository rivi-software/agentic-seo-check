/**
 * The hosted MCP server of Agentic SEO Check (issue #35): a stateless Worker that answers MCP over
 * Streamable HTTP at /mcp with the hosted tools of `createMcpServer`, and serves the pages that say
 * how to use it and what its requests are. The project's website is a Worker of its own
 * (src/site/worker.ts), so it deploys apart from the server. Both answer on one hostname (issue
 * #168): this Worker's routes there are its own paths only (wrangler.jsonc), and the files its
 * pages load come from the website.
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
import { freshResponse } from "./fresh.js";
import { FORMER_SERVER_HOSTS, hostedProfile, movedToOrigin } from "./limits.js";
import {
  crawlerPage,
  FAVICON_SVG,
  landingPage,
  notFoundPage,
} from "./pages.js";
import { DIRECTORY_PATH, directoryResponse, signingKeys } from "./signing.js";
import { SITE_JS } from "./site/files.js";
import { fontResponse, shareImageResponse } from "./ui/assets.js";
import { SERVER_CARD } from "./ui/og.js";
import { posthogResponse } from "./ui/posthog-script.js";
import { productHuntUpvotes } from "./ui/product-hunt.js";

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

/** A page or a file at an address it keeps from deploy to deploy, which browsers ask for again. */
const page = (
  request: Request,
  body: string,
  contentType: string,
  status = 200
): Promise<Response> =>
  freshResponse(
    request,
    body,
    { "content-type": contentType, "x-content-type-options": "nosniff" },
    status
  );

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

/**
 * A browser's visit, rather than an MCP client's: a GET or a HEAD that takes HTML. A client's GET
 * asks for an event stream, and keeps getting 405.
 */
const visit = (request: Request): boolean =>
  (request.method === "GET" || request.method === "HEAD") &&
  (request.headers.get("accept") ?? "").includes("text/html");

/** The server's page, at the server's address: one URL for an assistant and for a person. */
const serverPage = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> => {
  const upvotes = await productHuntUpvotes(request, ctx);
  const response = await page(request, landingPage(env, upvotes), HTML);
  response.headers.set("vary", "accept");

  return response;
};

/**
 * The files the pages load, which the website serves on the one hostname: here for `hosted:dev`,
 * which runs this Worker alone. The 404 page for any other path.
 */
const devFile = (
  request: Request,
  env: Env,
  pathname: string
): Response | Promise<Response> => {
  switch (pathname) {
    case "/favicon.svg": {
      return page(request, FAVICON_SVG, "image/svg+xml");
    }

    case "/site.js": {
      return page(request, SITE_JS, "text/javascript; charset=utf-8");
    }

    case "/ph.js": {
      return (
        posthogResponse(request, env.POSTHOG_HOST) ??
        page(request, notFoundPage(), HTML, 404)
      );
    }

    case SERVER_CARD.path: {
      return shareImageResponse(request, "server");
    }

    default: {
      return (
        fontResponse(request, pathname) ??
        page(request, notFoundPage(), HTML, 404)
      );
    }
  }
};

const route = (request: Request, env: Env, ctx: ExecutionContext) => {
  const { hostname, pathname } = new URL(request.url);
  const former = FORMER_SERVER_HOSTS.has(hostname);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: PREFLIGHT });
  }

  if (pathname === "/mcp" && !visit(request)) {
    return handleMcp(request, env, ctx);
  }

  // A former hostname keeps answering MCP, and the key directory that Signature-Agent names
  // (BOT_ORIGIN); its pages, the User-Agent's link included, are on the current one.
  if (former && pathname !== DIRECTORY_PATH) {
    return movedToOrigin(request, pathname === "/" ? "/mcp" : undefined);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.\n", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  switch (pathname) {
    case "/mcp": {
      return serverPage(request, env, ctx);
    }

    // The page moved to the server's address; on the one hostname, / is the website's.
    case "/": {
      return new Response(null, { status: 301, headers: { location: "/mcp" } });
    }

    case "/crawler": {
      return page(request, crawlerPage(), HTML);
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
      return devFile(request, env, pathname);
    }
  }
};

/** The paths an error's event may name (issue #60); any other is `other`. */
const KNOWN_PATHS = new Set([
  "/",
  "/mcp",
  "/crawler",
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
