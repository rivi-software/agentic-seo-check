/**
 * The MCP server's Worker (wrangler.jsonc) and the website's (wrangler.site.jsonc) deploy apart but
 * share their limits, so what one configuration states of them the other must state the same.
 */
import { describe, expect, it } from "vitest";

import { POSTHOG_HOST } from "../../src/telemetry/posthog.ts";
import { readConfig, SERVER_CONFIG, SITE_CONFIG } from "../scripts/defines.ts";
import {
  FORMER_SERVER_HOSTS,
  FORMER_SITE_HOST,
  ORIGIN,
  SERVER_PATHS,
} from "../src/limits.ts";

const server = readConfig(SERVER_CONFIG);
const site = readConfig(SITE_CONFIG);

/** A configuration's settings as Wrangler reads them; its types arrive untyped here. */
const settings = (config: typeof server) => ({
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags,
  limits: config.limits,
  alias: config.alias,
  observability: config.observability,
  analytics_engine_datasets: config.analytics_engine_datasets,
  r2_buckets: config.r2_buckets,
  DAILY_REQUESTS: config.vars["DAILY_REQUESTS"],
  CALLER_SITES: config.vars["CALLER_SITES"],
  PLATFORM_SITES: config.vars["PLATFORM_SITES"],
  POSTHOG_HOST: config.vars["POSTHOG_HOST"],
  STATE_JURISDICTION: config.vars["STATE_JURISDICTION"],
});

describe("the two Workers' configurations", () => {
  it("give the website the MCP server's runtime, limits, namespaces and dataset", () => {
    expect(settings(site)).toStrictEqual(settings(server));
  });

  it("give the website each of the MCP server's rate limits as the server has it, and the website's own beside them", () => {
    expect(site.ratelimits).toStrictEqual(
      expect.arrayContaining([
        ...server.ratelimits,
        // The premium waitlist's, the website's alone (issue #232).
        {
          name: "WAITLIST_SIGNUPS",
          namespace_id: "35007",
          simple: { limit: 5, period: 60 },
        },
        // Sign-in codes for the premium accounts (issue #229).
        {
          name: "SIGN_IN_CODES",
          namespace_id: "35008",
          simple: { limit: 5, period: 60 },
        },
      ])
    );
    expect(server.ratelimits).not.toContainEqual(
      expect.objectContaining({ name: "WAITLIST_SIGNUPS" })
    );
  });

  it("build the website as the MCP server, and then copy pdfmake for a report's PDF", () => {
    expect(site.build).toStrictEqual({
      ...server.build,
      command: `${server.build.command} && node scripts/pdfmake.ts`,
    });
  });

  it("bind the website to the MCP server's Durable Object", () => {
    const [state] = server.durable_objects.bindings;

    expect(site.durable_objects.bindings).toStrictEqual([
      {
        name: state?.name,
        class_name: state?.class_name,
        script_name: server.name,
      },
    ]);
  });

  it("keep traces off, since a fetch span holds the audited page's address (issue #208)", () => {
    expect(server.observability.traces).toStrictEqual({ enabled: false });
  });

  it("send the analytics to the host the website's CSP allows", () => {
    expect(server.vars["POSTHOG_HOST"]).toBe(POSTHOG_HOST);
    expect(site.vars["POSTHOG_HOST"]).toBe(POSTHOG_HOST);
  });

  it("keep the Durable Object in the EU (issue #78)", () => {
    expect(server.vars["STATE_JURISDICTION"]).toBe("eu");
  });

  it("route the hostname to the website, and the MCP server's own paths on it to the server (issue #168)", () => {
    const host = new URL(ORIGIN).hostname;

    expect(site.routes).toStrictEqual([
      { pattern: host, custom_domain: true },
      { pattern: FORMER_SITE_HOST, custom_domain: true },
    ]);

    expect(server.routes).toStrictEqual([
      ...SERVER_PATHS.map((path) => ({
        pattern: `${host}${path}`,
        zone_name: host,
      })),
      ...[...FORMER_SERVER_HOSTS].map((former) => ({
        pattern: former,
        custom_domain: true,
      })),
    ]);
  });
});
