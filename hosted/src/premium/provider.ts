/**
 * The premium server at premium.agentic-seo.org (issue #229): the hosted tools behind an account's
 * sign-in, as an OAuth 2.1 authorization server and its one protected resource, /mcp, with
 * @cloudflare/workers-oauth-provider. It serves the discovery documents, client registration and
 * the token endpoint itself, and checks each request's token before /mcp; /authorize is this
 * server's own page (authorize.ts). index.ts sends it the requests on the premium hostname only,
 * so agentic-seo.org serves none of OAuth's documents and its anonymous /mcp stays as it was.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

import { accountCaller } from "../callers.js";
import type { Caller } from "../callers.js";
import { entitlement } from "../entitlement.js";
import type { Paid } from "../entitlement.js";
import { PREMIUM_ORIGIN } from "../limits.js";
import { mayCallTool } from "../protocol-server.js";
import { authorize, PREMIUM_SCOPE } from "./authorize.js";

/** The Worker's bindings, and the helpers the provider adds before it calls the default handler. */
export type PremiumEnv = Env & { OAUTH_PROVIDER?: OAuthHelpers };

/** How a request to /mcp runs as a caller of the premium server: its account, and what it paid. */
export interface PremiumCall {
  caller: Caller;
  paid?: Paid;
}

export type McpHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  as?: PremiumCall
) => Promise<Response>;

/** What the premium hostname serves besides OAuth and /authorize: the pages' files, or not found. */
export type OtherHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
) => Response | Promise<Response>;

const RESOURCE = `${PREMIUM_ORIGIN}/mcp`;

/** Where the provider's challenge points a client, for /mcp (RFC 9728). */
const RESOURCE_METADATA = `${PREMIUM_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

/** What completeAuthorization stored with the grant: the account's id, and nothing else of it. */
const Props = z.object({ accountId: z.string().min(1) });

/**
 * The answer to a token whose account was deleted: the provider's own challenge for a token it no
 * longer takes, so the client signs in again.
 */
const accountGone = (): Response =>
  new Response(null, {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": `Bearer realm="OAuth", resource_metadata="${RESOURCE_METADATA}", error="invalid_token", scope="${PREMIUM_SCOPE}"`,
    },
  });

/**
 * The provider, once for the isolate. Its handler for /mcp runs `mcp` as the token's account. Only
 * a request that may call a tool reads the account: initialize, tools/list and the like cost no
 * read of the database.
 */
export const premiumProvider = (
  mcp: McpHandler,
  other: OtherHandler
): OAuthProvider<PremiumEnv> =>
  new OAuthProvider<PremiumEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, env, ctx) {
        const props = Props.safeParse(ctx.props);

        if (!props.success) {
          return accountGone();
        }

        const { accountId } = props.data;
        const caller = accountCaller(accountId);

        if (!(await mayCallTool(request))) {
          return mcp(request, env, ctx, { caller });
        }

        const { account, paid } = await entitlement(env, accountId, Date.now());

        if (account === null) {
          return accountGone();
        }

        return mcp(request, env, ctx, { caller, paid: paid ?? undefined });
      },
    },
    defaultHandler: {
      fetch(request, env, ctx) {
        const oauth = env.OAUTH_PROVIDER;

        if (new URL(request.url).pathname === "/authorize" && oauth) {
          return authorize(request, env, oauth);
        }

        return other(request, env, ctx);
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [PREMIUM_SCOPE],
    requiredScopes: [PREMIUM_SCOPE],
    resourceMetadata: {
      resource: RESOURCE,
      authorization_servers: [PREMIUM_ORIGIN],
    },
  });
