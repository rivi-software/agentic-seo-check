/**
 * The hosted MCP server of Agentic SEO Check (issue #35): a stateless Worker that answers MCP over
 * Streamable HTTP at /mcp with the hosted tools of `createMcpServer`, and serves the pages that say
 * how to use it and what its requests are. The project's website is a Worker of its own
 * (src/site/worker.ts), so it deploys apart from the server. Both answer on one hostname (issue
 * #168): this Worker's routes there are its own paths only (wrangler.jsonc), and the files its
 * pages load come from the website. The premium server (issue #229) is this Worker too, on its own
 * hostname: src/premium/ has it, and `premiumRequest` sends it its requests.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { onCaughtError } from "../../src/core/errors.js";
import { HOSTED_LIMITS } from "../../src/core/hosted.js";
import { HOSTED_TOOLS, PREMIUM_TOOLS } from "../../src/mcp-hosted.js";
import type { HostedProfile } from "../../src/mcp-hosted.js";
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
import { serverBrowser } from "./browser.js";
import {
  callerOf,
  openAiRangesReader,
  refreshOpenAiRanges,
} from "./callers.js";
import { backgroundCrawls } from "./crawls.js";
import { freshResponse } from "./fresh.js";
import {
  FORMER_SERVER_HOSTS,
  hostedProfile,
  movedToOrigin,
  PREMIUM_HOST,
  PREMIUM_ORIGIN,
} from "./limits.js";
import {
  crawlerPage,
  FAVICON_SVG,
  landingPage,
  notFoundPage,
} from "./pages.js";
import { premiumProvider } from "./premium/provider.js";
import type { PremiumCall } from "./premium/provider.js";
import { mayCallTool, protocolServers } from "./protocol-server.js";
import { refusalOf } from "./refused-requests.js";
import { keepReport } from "./shared-reports.js";
import { DIRECTORY_PATH, directoryResponse, signingKeys } from "./signing.js";
import { SITE_JS } from "./site/files.js";
import { fontResponse, shareImageResponse } from "./ui/assets.js";
import { SERVER_CARD } from "./ui/og.js";
import { posthogFileResponse } from "./ui/posthog-script.js";
import { productHuntUpvotes } from "./ui/product-hunt.js";

export { CrawlWorkflow } from "./crawls.js";

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

/**
 * How seo_share_report keeps a report (shared-reports.ts): in the bucket, as the server's own
 * audit. Its limit is the call's, which `admit` checks before the audits run (limits.ts).
 */
const reportKeeper = (env: Env): HostedProfile["share"] => {
  const bucket = env.SHARED_REPORTS;

  return bucket && ((report) => keepReport(bucket, report, "hosted"));
};

/** The servers for requests without a tool call, from a listing this isolate reads once. */
const protocolServer = protocolServers();

/** The same on the premium server, whose tools list `render` (issue #230). */
const premiumProtocolServer = protocolServers(createMcpServer, {
  premium: true,
});

/** OpenAI's ranges as this isolate reads them: from the Durable Object at most once an hour. */
const openAiRanges = openAiRangesReader();

/**
 * One MCP request: stateless, so every POST gets its own server and transport, and the answer is
 * JSON. A tool call gets the hosted server, built for its caller; anything else the light server
 * of protocol-server.ts, which answers alike. The `Mcp-Session-Id` an `initialize` is answered with is a token for the analytics alone
 * (analytics.ts), which any request can read without the server keeping anything. There is no
 * session to resume or end, so GET and DELETE answer 405, as the protocol allows. On the premium
 * server, `as` names the token's account as the caller, and what it paid, and its tools are the
 * premium server's, with the server's browser for a subscriber's `render` (issue #230).
 */
const handleMcp = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  as?: PremiumCall
): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("This MCP server takes POST requests only.\n", {
      status: 405,
      headers: { ...CORS, allow: "POST, OPTIONS" },
    });
  }

  const report = reportTask(env, ctx, "server:/mcp");

  const caller =
    as?.caller ??
    callerOf(
      request.headers.get("cf-connecting-ip"),
      await openAiRanges(env, ctx, report)
    );

  const tracking = hostedAnalytics(
    env,
    ctx,
    caller,
    request.headers.get("mcp-session-id"),
    as?.paid
  );

  const premium = as !== undefined;

  // A request that calls no tool, as nearly all are, needs nothing of the caller's (issue #211).
  const server = (await mayCallTool(request))
    ? createMcpServer({
        hosted: {
          ...hostedProfile(env, ctx, caller, {
            observe: tracking?.observe,
            report,
            paid: as?.paid,
          }),
          ...(premium && { premium, browser: serverBrowser(env.BROWSER) }),
          connection: tracking?.connection,
          share: reportKeeper(env),
          crawls: backgroundCrawls(env, report),
        },
      })
    : await (premium ? premiumProtocolServer : protocolServer)();

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    // The schemas cap inline HTML at 2,000,000 characters; this caps the whole request before it is
    // parsed.
    maxRequestBodySize: HOSTED_LIMITS.maxRequestBytes,
  });

  await server.connect(transport);

  if (tracking) {
    instrumentTransport(
      transport,
      tracking.analytics,
      premium ? PREMIUM_TOOLS : HOSTED_TOOLS
    );
  }

  try {
    const response = await transport.handleRequest(request);

    // A 4xx here is the transport refusing the request before any tool ran, which nothing else
    // hears (issue #210). Its answer is a small JSON error, read once here and sent on as it is.
    let body: BodyInit | null = response.body;

    if (tracking && response.status >= 400 && response.status < 500) {
      const text = await response.text();

      tracking.refused(refusalOf(request, response.status, text));
      body = text;
    }

    const headers = new Headers(response.headers);

    for (const [name, value] of Object.entries(CORS)) {
      headers.set(name, value);
    }

    // The client sends the session's token back with each request, so its calls share a session.
    const session = tracking?.sessionToken();

    if (session && response.ok) {
      headers.set("mcp-session-id", session);
    }

    return new Response(body, { status: response.status, headers });
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

    case SERVER_CARD.path: {
      return shareImageResponse(request, "server");
    }

    default: {
      return (
        posthogFileResponse(request, pathname, env.POSTHOG_HOST) ??
        fontResponse(request, pathname) ??
        page(request, notFoundPage(), HTML, 404)
      );
    }
  }
};

/** The premium hostname serves the pages' files beside OAuth and /authorize, and not found else. */
const premiumOther = (
  request: Request,
  env: Env
): Response | Promise<Response> =>
  request.method === "GET" || request.method === "HEAD"
    ? devFile(request, env, new URL(request.url).pathname)
    : new Response("Method not allowed.\n", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });

/** The premium server, built once for the isolate. */
const premium = premiumProvider(handleMcp, premiumOther);

/**
 * Whether a request is the premium server's: its hostname, or, where PREMIUM_DEV is "on"
 * (.dev.vars), the header that stands for it, since `hosted:dev` and the tests give every request
 * the first route's hostname.
 */
const premiumRequest = (request: Request, env: Env): boolean =>
  new URL(request.url).hostname === PREMIUM_HOST ||
  (env.PREMIUM_DEV === "on" &&
    request.headers.get("x-agentic-seo-premium") === "1");

/**
 * The request on the premium hostname, which the provider checks every address against: a local
 * request has another, and keeps its path, query, method, headers and body.
 */
const onPremiumHost = (request: Request): Request => {
  const { hostname, pathname, search } = new URL(request.url);

  return hostname === PREMIUM_HOST
    ? request
    : new Request(`${PREMIUM_ORIGIN}${pathname}${search}`, request);
};

const route = (request: Request, env: Env, ctx: ExecutionContext) => {
  if (premiumRequest(request, env)) {
    return premium.fetch(onPremiumHost(request), env, ctx);
  }

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
  "/ph-recorder.js",
  "/favicon.svg",
  DIRECTORY_PATH,
  // The premium server's (src/premium/).
  "/authorize",
  "/oauth/token",
  "/oauth/register",
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
