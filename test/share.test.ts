/**
 * Sharing a report from the CLI, the local MCP server or the library (src/core/share.ts): which
 * audits a target gives, and the upload, here to a local server in the website's place. The website's
 * side is tested in hosted/test/shared-report.test.ts.
 */
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { DEFAULT_USER_AGENT } from "../src/core/fetch.js";
import {
  auditForShare,
  MAX_SHARE_BYTES,
  ShareError,
  shareAudits,
} from "../src/core/share.js";
import type { SharedReport } from "../src/core/share.js";
import { siteRoutes, startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer } from "./helpers/fixture-server.js";

/** What the stand-in for the website was sent, and what it answers. */
interface Upload {
  body: string;
  userAgent: string | undefined;
}

const startWebsite = async (answer: { status: number; body: string }) => {
  const uploads: Upload[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      uploads.push({
        body: Buffer.concat(chunks).toString("utf-8"),
        userAgent: req.headers["user-agent"],
      });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  // SAFETY: the server listens on a TCP port, never a pipe, so its address is an AddressInfo.
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}/api/share`,
    uploads,
    close: () => server[Symbol.asyncDispose](),
  };
};

const LINK = {
  url: "https://agentic-seo.org/report/AAAAAAAAAAAAAAAAAAAAAA",
  expiresAt: "2026-12-21T00:00:00.000Z",
};

const Uploaded = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["page", "site"]),
  seo: z.record(z.string(), z.unknown()),
  aeo: z.record(z.string(), z.unknown()),
});

describe("sharing a report", () => {
  let site: FixtureServer;

  beforeAll(async () => {
    site = await startFixtureServer(siteRoutes());
  });

  afterAll(async () => {
    await site.close();
  });

  it("audits a page for both audits, and a site from one crawl", async () => {
    const page = await auditForShare(`${site.origin}/about/`);
    const crawl = await auditForShare(`${site.origin}/`, { crawl: true });

    expect([page.kind, page.seo.kind, page.aeo.kind]).toStrictEqual([
      "page",
      "page",
      "aeo",
    ]);
    expect([crawl.kind, crawl.seo.kind, crawl.aeo.source]).toStrictEqual([
      "site",
      "site",
      "crawl",
    ]);
  });

  it("shares no single file, which has no address of its own", async () => {
    await expect(auditForShare("test/fixtures/good-page.html")).rejects.toThrow(
      ShareError
    );
  });

  it("uploads both audits with the tool's User-Agent and answers with the link", async () => {
    const website = await startWebsite({
      status: 201,
      body: JSON.stringify(LINK),
    });

    try {
      const report = await auditForShare(`${site.origin}/about/`);
      const link = await shareAudits(report, { endpoint: website.endpoint });
      const [upload] = website.uploads;

      expect(link).toStrictEqual(LINK);
      expect(upload?.userAgent).toBe(DEFAULT_USER_AGENT);
      expect(Uploaded.parse(JSON.parse(upload?.body ?? "")).kind).toBe("page");
    } finally {
      await website.close();
    }
  });

  it("says why the website refused an upload, in its words", async () => {
    const website = await startWebsite({
      status: 429,
      body: JSON.stringify({ error: "Too many reports shared." }),
    });

    try {
      const report = await auditForShare(`${site.origin}/about/`);

      await expect(
        shareAudits(report, { endpoint: website.endpoint })
      ).rejects.toThrow("The report was not shared: Too many reports shared.");
    } finally {
      await website.close();
    }
  });

  it("sends nothing over the size the website takes", async () => {
    const report = await auditForShare(`${site.origin}/about/`);

    const huge: SharedReport = {
      ...report,
      aeo: { ...report.aeo, target: "x".repeat(MAX_SHARE_BYTES) },
    };

    await expect(
      shareAudits(huge, { endpoint: "http://127.0.0.1:9/never" })
    ).rejects.toThrow("over the 5 MB a shared report may be");
  });
});
