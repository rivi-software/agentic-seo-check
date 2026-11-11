/**
 * The MCP server's Worker (wrangler.jsonc) and the website's (wrangler.site.jsonc) deploy apart but
 * share their limits, so what one configuration states of them the other must state the same.
 */
import { describe, expect, it } from "vitest";

import { readConfig, SERVER_CONFIG, SITE_CONFIG } from "../scripts/defines.ts";
import { SITE_ORIGIN } from "../src/limits.ts";

const server = readConfig(SERVER_CONFIG);
const site = readConfig(SITE_CONFIG);

/** A configuration's settings as Wrangler reads them; its types arrive untyped here. */
const settings = (config: typeof server) => ({
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags,
  build: config.build,
  limits: config.limits,
  alias: config.alias,
  observability: config.observability,
  ratelimits: config.ratelimits,
  analytics_engine_datasets: config.analytics_engine_datasets,
  DAILY_REQUESTS: config.vars["DAILY_REQUESTS"],
  CALLER_SITES: config.vars["CALLER_SITES"],
  PLATFORM_SITES: config.vars["PLATFORM_SITES"],
  POSTHOG_HOST: config.vars["POSTHOG_HOST"],
});

describe("the two Workers' configurations", () => {
  it("give the website the MCP server's runtime, limits, namespaces and dataset", () => {
    expect(settings(site)).toStrictEqual(settings(server));
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

  it("route the website's hostname to the website alone", () => {
    const host = new URL(SITE_ORIGIN).hostname;

    const patterns = (config: typeof server) =>
      (config.routes ?? []).map((route: { pattern: string }) => route.pattern);

    expect(patterns(site)).toStrictEqual([host]);
    expect(patterns(server)).not.toContain(host);
  });
});
