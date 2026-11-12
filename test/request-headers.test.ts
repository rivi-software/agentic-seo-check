import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditAeoUrl } from "../src/core/aeo/audit.js";
import { auditSite, auditUrl } from "../src/core/audit.js";
import { browserRequestHeaders } from "../src/core/browser-headers.js";
import { fetchPage, headersGoTo } from "../src/core/fetch.js";
import { startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer, Routes } from "./helpers/fixture-server.js";

const SECRET = "Basic c3RhZ2luZzpzZWNyZXQ=";
const headers = { Authorization: SECRET, "X-Staging": "yes" };

const html = (body: string) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>A page of the staging site</title></head><body><h1>Staging</h1>${body}</body></html>`;

const names = (list: { name: string }[]) => list.map((h) => h.name);

/** The paths a server was asked for with the user's Authorization header. */
const withSecret = (server: FixtureServer): string[] =>
  server.requests.filter(
    (_path, index) => server.requestHeaders[index]?.["authorization"] === SECRET
  );

describe("the user's request headers go to the audited origin only", () => {
  let site: FixtureServer;
  let other: FixtureServer;
  const siteRoutes: Routes = {};
  const otherRoutes: Routes = {};

  beforeAll(async () => {
    site = await startFixtureServer(siteRoutes);
    other = await startFixtureServer(otherRoutes);

    // The other server under another hostname too, so the crawl takes its pages for external.
    const external = other.origin.replace("localhost", "127.0.0.1");

    Object.assign(otherRoutes, {
      "/landed": { body: html("<p>Another site.</p>") },
      "/linked": { body: html("<p>Another site.</p>") },
    });

    Object.assign(siteRoutes, {
      "/": {
        body: html(
          `<a href="/about">About</a> <a href="${external}/linked">Elsewhere</a> <a href="/leaves">Leaves</a>`
        ),
      },
      "/about": { body: html('<a href="/">Home</a>') },
      "/moved": { status: 301, headers: { location: "/about" } },
      "/leaves": {
        status: 302,
        headers: { location: `${other.origin}/landed` },
      },
    });
  });

  afterAll(async () => {
    await site.close();
    await other.close();
  });

  const reset = () => {
    for (const server of [site, other]) {
      server.requests.length = 0;
      server.requestHeaders.length = 0;
      server.userAgents.length = 0;
    }
  };

  describe(headersGoTo, () => {
    it("lets the headers go to the audited origin, and to the same host once it upgrades to https", () => {
      expect(
        headersGoTo("https://staging.example/a", "https://staging.example")
      ).toBeTruthy();
      expect(
        headersGoTo("https://staging.example/a", "http://staging.example/")
      ).toBeTruthy();
    });

    it("keeps them from another host, another port, a step down to http and a URL with no origin", () => {
      const audited = "https://staging.example/";

      for (const url of [
        "https://evil.example/",
        "https://www.staging.example/",
        "https://staging.example.evil.example/",
        "https://staging.example:8443/",
        "http://staging.example/",
        "file:///etc/passwd",
        "not a url",
      ]) {
        expect(headersGoTo(url, audited)).toBeFalsy();
      }

      expect(
        headersGoTo("https://staging.example:8443/", "http://staging.example/")
      ).toBeFalsy();
      expect(headersGoTo("file:///a", "file:///b")).toBeFalsy();
    });
  });

  describe(fetchPage, () => {
    it("sends the headers along a redirect on the same origin", async () => {
      reset();
      const res = await fetchPage(`${site.origin}/moved`, { headers });

      expect(res.status).toBe(200);
      expect(withSecret(site)).toStrictEqual(["/moved", "/about"]);
    });

    it("sends the headers no further when a redirect leaves the origin", async () => {
      reset();
      const res = await fetchPage(`${site.origin}/leaves`, { headers });

      expect(res.finalUrl).toBe(`${other.origin}/landed`);
      expect(withSecret(site)).toStrictEqual(["/leaves"]);
      expect(other.requests).toStrictEqual(["/landed"]);
      expect(withSecret(other)).toStrictEqual([]);
      expect(other.requestHeaders[0]?.["x-staging"]).toBeUndefined();
    });

    it("holds the headers to `headersOrigin` when the fetch starts elsewhere", async () => {
      reset();

      await fetchPage(`${other.origin}/landed`, {
        headers,
        headersOrigin: site.origin,
      });

      expect(other.requests).toStrictEqual(["/landed"]);
      expect(withSecret(other)).toStrictEqual([]);
    });
  });

  describe(auditUrl, () => {
    it("audits a page that redirects to another origin without handing that origin the headers", async () => {
      reset();

      const audit = await auditUrl(`${site.origin}/leaves`, {
        fetch: { headers },
      });

      expect(audit.url).toBe(`${other.origin}/landed`);
      expect(withSecret(site)).toStrictEqual(["/leaves"]);
      expect(withSecret(other)).toStrictEqual([]);
    });
  });

  describe(auditAeoUrl, () => {
    it("reads the robots.txt and llms.txt of the origin a redirect ended at without the headers", async () => {
      reset();
      await auditAeoUrl(`${site.origin}/leaves`, { fetch: { headers } });

      expect(other.requests).toContain("/robots.txt");
      expect(other.requests).toContain("/llms.txt");
      expect(withSecret(other)).toStrictEqual([]);
    });
  });

  describe(auditSite, () => {
    it("crawls the site with the headers and checks its external links without them", async () => {
      reset();

      await auditSite(`${site.origin}/`, {
        checkExternalLinks: true,
        fetch: { headers },
      });

      expect(withSecret(site)).toContain("/");
      expect(withSecret(site)).toContain("/about");
      // The external link, and the page the site's own redirect leads to.
      expect(other.requests).toContain("/linked");
      expect(other.requests).toContain("/landed");
      expect(withSecret(other)).toStrictEqual([]);
    });
  });

  describe(browserRequestHeaders, () => {
    const audited = "https://staging.example/";

    it("adds the headers to a request to the audited origin, in place of the page's own", () => {
      const list = browserRequestHeaders(
        { Accept: "*/*", authorization: "Bearer page" },
        "https://staging.example/app.js",
        headers,
        audited
      );

      expect(list).toStrictEqual([
        { name: "Accept", value: "*/*" },
        { name: "Authorization", value: SECRET },
        { name: "X-Staging", value: "yes" },
      ]);
    });

    it("leaves a request to another origin as the page sent it", () => {
      const list = browserRequestHeaders(
        { Accept: "*/*", Authorization: "Bearer page" },
        "https://cdn.example/font.woff2",
        headers,
        audited
      );

      expect(list).toStrictEqual([
        { name: "Accept", value: "*/*" },
        { name: "Authorization", value: "Bearer page" },
      ]);
    });

    it("takes the headers out of a request a redirect carried them to", () => {
      const list = browserRequestHeaders(
        { Accept: "*/*", authorization: SECRET, "x-staging": "yes" },
        "https://evil.example/collect",
        headers,
        audited
      );

      expect(names(list)).toStrictEqual(["Accept"]);
    });
  });
});
