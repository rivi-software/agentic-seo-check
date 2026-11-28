import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auditUrl } from "../src/core/audit.js";
import type { AuditOptions } from "../src/core/audit.js";
import type { RequestGate } from "../src/core/fetch.js";
import { summarize } from "../src/core/lighthouse.js";
import type { LhrLike } from "../src/core/lighthouse.js";
import { performanceFindings } from "../src/core/performance-rules.js";
import { LabUnavailableError } from "../src/core/psi.js";
import type { LabRunner } from "../src/core/psi.js";
import { RenderUnavailableError } from "../src/core/render.js";
import type { RenderBrowser } from "../src/core/render.js";
import lhrJson from "./fixtures/psi-lhr.json" with { type: "json" };
import { siteRoutes, startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer } from "./helpers/fixture-server.js";

const lhr: LhrLike = lhrJson;

const fixtureLab: LabRunner = () => Promise.resolve(lhr);

describe("a supplied lab runner", () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer(siteRoutes());
  });

  afterAll(async () => {
    await server.close();
  });

  const audit = (options: AuditOptions) =>
    auditUrl(`${server.origin}/`, { includeInfo: true, ...options });

  it("is never called when the gate refuses, and the audit answers the refusal", async () => {
    const lab = vi.fn<LabRunner>(() => Promise.resolve(lhr));
    let asked = 0;

    // The page itself is let through; the lab's request is the refused one.
    const gate: RequestGate = {
      beforeRequest: () => {
        asked += 1;

        return asked > 1
          ? {
              message: "robots.txt says no.",
              scope: "url",
              reason: "robots_txt",
            }
          : undefined;
      },
    };

    await expect(
      audit({ lighthouse: true, lab, fetch: { gate } })
    ).rejects.toMatchObject({
      name: "RequestRefusedError",
      message: "robots.txt says no.",
    });
    expect(lab).not.toHaveBeenCalled();
  });

  it("asks the lab gate, not the page's gate, and answers its refusal with no lab run", async () => {
    const lab = vi.fn<LabRunner>(() => Promise.resolve(lhr));

    const labGate: RequestGate = {
      beforeRequest: () => ({
        message: "robots.txt keeps the lab out.",
        scope: "url",
        reason: "robots_txt",
      }),
    };

    await expect(
      audit({
        lighthouse: true,
        lab,
        fetch: {
          gate: {
            beforeRequest: () => {
              // The page's own gate lets everything through.
            },
          },
          labGate,
        },
      })
    ).rejects.toMatchObject({
      name: "RequestRefusedError",
      message: "robots.txt keeps the lab out.",
    });
    expect(lab).not.toHaveBeenCalled();
  });

  it("gives tool.lighthouse-unavailable when the runner is unavailable", async () => {
    const result = await audit({
      lighthouse: true,
      lab: () => Promise.reject(new LabUnavailableError("Lab is busy.")),
    });

    const finding = result.findings.find(
      (f) => f.rule === "tool.lighthouse-unavailable"
    );

    expect(finding?.message).toContain("Lab is busy.");
    expect(result.performance).toBeUndefined();
  });

  it("builds the findings of a PSI result with no agentic-browsing category", async () => {
    const lab = vi.fn<LabRunner>(() => Promise.resolve(lhr));

    const result = await audit({
      lighthouse: true,
      formFactor: "desktop",
      lab,
    });

    const expected = performanceFindings(
      summarize(lhr, `${server.origin}/`, "desktop")
    ).map((f) => f.rule);

    const got = result.findings.map((f) => f.rule);

    expect(lab).toHaveBeenCalledWith(`${server.origin}/`, "desktop");
    expect(result.performance?.metrics.agenticBrowsingScore).toBeNull();
    expect(expected.length).toBeGreaterThan(0);
    expect(got).toStrictEqual(expect.arrayContaining(expected));
    expect(got).not.toContain("lighthouse.agentic-audit-failed");
  });

  it("says the result is PageSpeed Insights', and what it did not measure, as its last keys", async () => {
    const result = await audit({
      lighthouse: true,
      lab: () => Promise.resolve(lhr),
    });

    const keys = Object.keys(result.performance ?? {});

    expect(result.performance?.source).toBe("pagespeed-insights");
    expect(result.performance?.notMeasured).toStrictEqual(["agentic-browsing"]);
    expect(keys.slice(-2)).toStrictEqual(["source", "notMeasured"]);
  });

  it("names nothing as not measured when the lab returned every category", async () => {
    const full: LhrLike = {
      ...lhr,
      categories: {
        ...lhr.categories,
        "agentic-browsing": { score: 1, auditRefs: [] },
      },
    };

    const result = await audit({
      lighthouse: true,
      lab: () => Promise.resolve(full),
    });

    expect(result.performance?.notMeasured).toStrictEqual([]);
  });

  it("leaves source and notMeasured off a local Lighthouse run's summary", () => {
    const local = summarize(lhr, "https://www.example.com/", "mobile");

    expect(local).not.toHaveProperty("source");
    expect(local).not.toHaveProperty("notMeasured");
  });

  it("starts the lab and the render together, not one after the other", async () => {
    const started: string[] = [];
    const met: string[] = [];

    // Each fake waits, a second at most, for the other to start: one after the other, the first
    // would give up alone.
    const meet = async (name: string): Promise<void> => {
      started.push(name);

      await vi.waitFor(() => {
        expect(started).toHaveLength(2);
      });

      met.push(name);
    };

    const lab: LabRunner = async () => {
      await meet("lab");

      return lhr;
    };

    const launch = async (): Promise<RenderBrowser> => {
      await meet("render");

      throw new RenderUnavailableError("No browser in this test.");
    };

    const result = await audit({
      lighthouse: true,
      render: true,
      lab,
      browser: { launch },
    });

    expect(met.toSorted()).toStrictEqual(["lab", "render"]);
    expect(result.performance?.source).toBe("pagespeed-insights");
  });

  it("answers a lab refusal only once the render beside it has settled", async () => {
    const events: string[] = [];

    const labGate: RequestGate = {
      beforeRequest: () => ({
        message: "robots.txt keeps the lab out.",
        scope: "url",
        reason: "robots_txt",
      }),
    };

    const launch = async (): Promise<RenderBrowser> => {
      await sleep(100);
      events.push("render settled");

      throw new RenderUnavailableError("No browser in this test.");
    };

    await expect(
      audit({
        lighthouse: true,
        render: true,
        lab: fixtureLab,
        browser: { launch },
        fetch: { labGate },
      })
    ).rejects.toMatchObject({ name: "RequestRefusedError" });
    events.push("answered");

    expect(events).toStrictEqual(["render settled", "answered"]);
  });

  it("reads the metrics of the fixture", async () => {
    const result = await audit({
      lighthouse: true,
      lab: () => Promise.resolve(lhr),
    });

    expect(result.performance?.metrics.performanceScore).toBe(62);
    expect(result.performance?.metrics.lcpMs).toBe(4600);
  });

  it("fires no rule on a result with no data", () => {
    const bare = summarize(
      { lighthouseVersion: "13", categories: {}, audits: {} },
      "https://www.example.com/",
      "mobile"
    );

    expect(bare.metrics.performanceScore).toBeNull();
    expect(performanceFindings(bare)).toStrictEqual([]);
  });
});
