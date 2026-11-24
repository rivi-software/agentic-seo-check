import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auditUrl } from "../src/core/audit.js";
import type { AuditOptions } from "../src/core/audit.js";
import type { RequestGate } from "../src/core/fetch.js";
import { summarize } from "../src/core/lighthouse.js";
import type { LhrLike } from "../src/core/lighthouse.js";
import { performanceFindings } from "../src/core/performance-rules.js";
import { LabUnavailableError } from "../src/core/psi.js";
import type { LabRunner } from "../src/core/psi.js";
import lhrJson from "./fixtures/psi-lhr.json" with { type: "json" };
import { siteRoutes, startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer } from "./helpers/fixture-server.js";

const lhr: LhrLike = lhrJson;

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
