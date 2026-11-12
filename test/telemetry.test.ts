import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";

import { auditSite, auditUrl } from "../src/core/audit.js";
import { ExpectedError } from "../src/core/errors.js";
import { RequestRefusedError } from "../src/core/fetch.js";
import { CallLimitError } from "../src/mcp-hosted.js";
import { createMcpServer, LOCAL_TOOLS } from "../src/mcp.js";
import {
  cliEvent,
  localMcpAnalytics,
  NOTICE,
  NOTICE_VERSION,
  offByEnv,
  prepareTelemetry,
  settingsPath,
  startCliRun,
  targetKind,
  telemetryCommand,
  telemetryStatus,
} from "../src/telemetry/local.js";
import {
  clientToken,
  instrumentTransport,
  intentOf,
} from "../src/telemetry/mcp.js";
import type {
  McpAnalytics,
  McpCaller,
  McpToolCall,
} from "../src/telemetry/mcp.js";
import { sendEvents, uuidv7 } from "../src/telemetry/posthog.js";
import type { PostHogEvent } from "../src/telemetry/posthog.js";
import { runReport } from "../src/telemetry/report.js";
import { siteRoutes, startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer } from "./helpers/fixture-server.js";

/** An environment with a settings file of its own, and none of the variables that turn telemetry off. */
const freshEnv = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "telemetry-"));

  return { home, env: { XDG_CONFIG_HOME: home } };
};

/** A stderr that records what is written to it: a pipe, or a terminal `columns` wide. */
const stderrRecorder = (terminal?: { columns: number }) => {
  const written: string[] = [];

  return {
    written,
    stderr: {
      isTTY: terminal !== undefined,
      columns: terminal?.columns ?? 0,
      hasColors: () => false,
      write: (text: string) => {
        written.push(text);

        return true;
      },
    },
  };
};

/** A local server with `analytics` on its transport, and a client connected to it. */
const connect = async (analytics: McpAnalytics) => {
  const server = createMcpServer();
  const client = new Client({ name: "telemetry-test", version: "4.5.6" });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  instrumentTransport(serverTransport, analytics, LOCAL_TOOLS);
  await client.connect(clientTransport);

  return client;
};

/** Analytics that keep what they hear. */
const recorder = () => {
  const calls: McpToolCall[] = [];
  const starts: McpCaller[] = [];

  const analytics: McpAnalytics = {
    toolCall: (call) => calls.push(call),
    initialize: (caller) => starts.push(caller),
  };

  return { calls, starts, analytics };
};

const EVENT = { event: "x", properties: { distinct_id: "d" } };

/** os.homedir() without HOME, in a container that runs under an arbitrary UID. */
const noHome = (): string => {
  throw new Error("ENOENT: no such file or directory, uv_os_homedir");
};

describe("telemetry", () => {
  describe("sending", () => {
    it("makes UUIDv7s, whose first bytes are the time", () => {
      const at = Date.UTC(2026, 10, 11);
      const id = uuidv7(at);

      expect(id).toMatch(
        /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u
      );
      expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(at);
    });

    it("posts a batch with the project's token", async () => {
      const sent: { url: string; body: string }[] = [];

      const ok = await sendEvents([EVENT], {
        host: "https://posthog.test",
        fetch: (url, init) => {
          sent.push({ url: String(url), body: String(init?.body) });

          return Promise.resolve(Response.json({ status: 1 }));
        },
      });

      expect(ok).toBeTruthy();
      expect(sent.map((s) => s.url)).toStrictEqual([
        "https://posthog.test/batch/",
      ]);
      expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({
        api_key: expect.stringMatching(/^phc_/u),
        batch: [EVENT],
      });
    });

    it("never throws when PostHog cannot be reached", async () => {
      const ok = await sendEvents([EVENT], {
        fetch: () => Promise.reject(new Error("offline")),
      });

      expect(ok).toBeFalsy();
    });
  });

  describe("on and off", () => {
    let fresh: Awaited<ReturnType<typeof freshEnv>>;

    beforeAll(async () => {
      fresh = await freshEnv();
    });

    afterAll(async () => {
      await rm(fresh.home, { recursive: true, force: true });
    });

    it("is off with DO_NOT_TRACK, AGENTIC_SEO_CHECK_TELEMETRY=0 or CI", () => {
      expect(
        [
          {},
          { DO_NOT_TRACK: "1" },
          { DO_NOT_TRACK: "0" },
          { AGENTIC_SEO_CHECK_TELEMETRY: "off" },
          { CI: "true" },
          { CI: "false" },
        ].map((env) => offByEnv(env))
      ).toStrictEqual([
        null,
        "DO_NOT_TRACK is set",
        null,
        "AGENTIC_SEO_CHECK_TELEMETRY is off",
        "CI is set",
        null,
      ]);
    });

    it("keeps the user's choice in their config directory", () => {
      expect(settingsPath({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe(
        path.join("/x", "agentic-seo-check", "telemetry.json")
      );
      expect(settingsPath({ APPDATA: "C:\\A" }, "win32")).toBe(
        path.join("C:\\A", "agentic-seo-check", "telemetry.json")
      );
    });

    it("turns off and on with the telemetry command", async () => {
      const before = await telemetryCommand("status", fresh.env);
      const off = await telemetryCommand("disable", fresh.env);
      const sends = await prepareTelemetry({ env: fresh.env });

      await telemetryCommand("enable", fresh.env);
      const status = await telemetryStatus(fresh.env);

      expect(before).toMatch(
        /^Telemetry is on\n\n {2}Anonymous usage data goes to RIVI Software's PostHog project \(EU\)\.\n/u
      );
      expect(off).toMatch(
        /^✓ Telemetry is off\.\n\n {2}Turned off with `agentic-seo-check telemetry disable`\.\n[^]*\n {2}Turn it on again: agentic-seo-check telemetry enable\n$/u
      );
      expect(sends).toBeFalsy();
      expect(status.enabled).toBeTruthy();
    });

    it("says what is sent while it is on, and that the environment keeps it off", async () => {
      const on = await telemetryCommand("status", fresh.env);

      const kept = await telemetryCommand("enable", {
        ...fresh.env,
        DO_NOT_TRACK: "1",
      });

      expect(on).toMatch(
        /^ {2}Never sent {2}a URL, a hostname, a path or anything from a page$/mu
      );
      expect(on).toContain(`  Settings    ${settingsPath(fresh.env)}\n`);
      expect(kept).toMatch(/^▲ Telemetry stays off\. Your choice is kept/u);
      expect(kept).toContain("\n  DO_NOT_TRACK is set.\n");
      expect(kept).not.toContain("Turn it");
    });

    it("is off, and says nothing, where there is no home directory", async () => {
      const { written, stderr } = stderrRecorder();

      const sends = await prepareTelemetry({
        env: {},
        home: noHome,
        stderr,
      });

      expect(sends).toBeFalsy();
      expect(written).toStrictEqual([]);
      expect([
        settingsPath({ XDG_CONFIG_HOME: "/config" }, "linux", noHome),
        settingsPath({ APPDATA: "/appdata" }, "win32", noHome),
      ]).toStrictEqual([
        path.join("/config", "agentic-seo-check", "telemetry.json"),
        path.join("/appdata", "agentic-seo-check", "telemetry.json"),
      ]);
    });

    it("says it is on once, on stderr, on the first run", async () => {
      const { home, env } = await freshEnv();
      const { written, stderr } = stderrRecorder();

      const first = await prepareTelemetry({ env, stderr });
      const second = await prepareTelemetry({ env, stderr });
      const settings = await readFile(settingsPath(env), "utf-8");

      expect([first, second]).toStrictEqual([true, true]);
      expect(written).toStrictEqual([`${NOTICE}\n`]);
      expect(JSON.parse(settings)).toMatchObject({
        noticeShown: expect.any(String),
        noticeVersion: NOTICE_VERSION,
      });

      await rm(home, { recursive: true, force: true });
    });

    it("wraps the notice to a terminal's width, under a heading", async () => {
      const { home, env } = await freshEnv();
      const { written, stderr } = stderrRecorder({ columns: 60 });

      await prepareTelemetry({ env, stderr });

      const lines = written.join("").split("\n");

      expect(lines[0]).toBe(`Telemetry ${"─".repeat(50)}`);
      expect(lines.slice(2).join(" ").replaceAll(/\s+/gu, " ")).toContain(
        "the type and stack of an unexpected error. Never a URL, a hostname, a path or anything from a page."
      );
      expect(lines.filter((line) => line.length > 60)).toStrictEqual([
        "  Details      https://github.com/rivi-software/agentic-seo-check#telemetry",
      ]);
      expect(lines).toContain(
        "  Turn it off  agentic-seo-check telemetry disable"
      );

      await rm(home, { recursive: true, force: true });
    });

    it("says it once more to a user who saw the notice before it named errors", async () => {
      const { home, env } = await freshEnv();
      const { written, stderr } = stderrRecorder();

      // The settings issue #57's release wrote: a notice, without its version.
      await mkdir(path.dirname(settingsPath(env)), { recursive: true });
      await writeFile(settingsPath(env), '{ "noticeShown": "2026-11-11" }');

      await prepareTelemetry({ env, stderr });
      await prepareTelemetry({ env, stderr });

      expect(written).toStrictEqual([`${NOTICE}\n`]);
      expect(NOTICE).toMatch(/type and stack of an unexpected error/u);

      await rm(home, { recursive: true, force: true });
    });
  });

  describe("the CLI's event", () => {
    let server: FixtureServer;

    beforeAll(async () => {
      server = await startFixtureServer(siteRoutes());
    });

    afterAll(async () => {
      await server.close();
    });

    it("names the kind of target, never the target", async () => {
      const kinds = await Promise.all(
        [
          "-",
          "https://example.com/a",
          "example.com",
          "http://localhost:3000/",
          "http://127.0.0.1:8080/",
          "test/fixtures",
          "test/fixtures/good-page.html",
          "no/such/thing",
        ].map((target) => targetKind(target))
      );

      expect(kinds).toStrictEqual([
        "stdin",
        "url",
        "url",
        "localhost",
        "localhost",
        "directory",
        "file",
        undefined,
      ]);
    });

    it("counts a crawl's pages and findings and lists its rules, with nothing from the site", async () => {
      const site = await auditSite(`${server.origin}/`, { maxPages: 10 });
      const run = startCliRun("crawl", ["--max-pages", "--format"]);
      run.target = await targetKind(`${server.origin}/`);
      run.format = "text";
      run.report = runReport(site);

      const event = cliEvent(run, 1);
      const json = JSON.stringify(event);

      expect(event).toMatchObject({
        event: "cli_command",
        properties: {
          surface: "cli",
          command: "crawl",
          flags: ["--max-pages", "--format"],
          target: "localhost",
          format: "text",
          exit_code: 1,
          pages: site.pages.length,
          errors: site.counts.error,
          warnings: site.counts.warning,
          $process_person_profile: false,
        },
      });
      expect(run.report.rules).toContain("site.broken-internal-links");
      expect(run.report.rules).toStrictEqual(
        [...new Set(run.report.rules)].toSorted()
      );
      expect(json).not.toContain(new URL(server.origin).host);
      expect(json).not.toMatch(/fixture|widgets/iu);
    });

    it("gives each run an id of its own, so no two can be linked", () => {
      expect(
        cliEvent(startCliRun("rules", []), 0).properties.distinct_id
      ).not.toBe(cliEvent(startCliRun("rules", []), 0).properties.distinct_id);
    });

    it("counts one page for a page audit", async () => {
      const page = await auditUrl(`${server.origin}/about/`);

      expect(runReport(page)).toMatchObject({ pages: 1, counts: page.counts });
    });
  });

  describe("the MCP servers' events", () => {
    it("hears each initialize and each call to a tool of the server", async () => {
      const { calls, starts, analytics } = recorder();
      const client = await connect(analytics);

      await client.callTool({
        name: "seo_list_rules",
        arguments: { rule: "title.missing", context: "look up a rule" },
      });
      await client.callTool({ name: "no_such_tool", arguments: {} });
      await client.close();

      expect(starts).toStrictEqual([
        expect.objectContaining({
          clientName: "telemetry-test",
          clientVersion: "4.5.6",
        }),
      ]);
      // The call to a tool the server does not have is left out: its name is the caller's.
      expect(calls).toStrictEqual([
        expect.objectContaining({
          tool: "seo_list_rules",
          isError: false,
          errorType: undefined,
          clientName: "telemetry-test",
          clientVersion: "4.5.6",
          durationMs: expect.any(Number),
        }),
      ]);
      // The local server's events name no arguments and no intent (issue #84 is the hosted one's).
      expect(calls[0]?.arguments).toBeUndefined();
      expect(calls[0]?.intent).toBeUndefined();
      expect(calls[0]?.properties).toStrictEqual({});
    });

    it("tells the kinds of failure apart", async () => {
      const { calls, analytics } = recorder();
      const client = await connect(analytics);

      // No target: the tool's own answer.
      await client.callTool({ name: "seo_audit_page", arguments: {} });
      // An argument the schema refuses: the SDK's answer.
      await client.callTool({
        name: "seo_audit_page",
        arguments: { url: "https://shop.example.com/", timeoutMs: "slow" },
      });
      // A directory that is not there: a failure the tool expects and explains.
      await client.callTool({
        name: "seo_audit_directory",
        arguments: { dir: "no/such/dir" },
      });
      // A rule the SEO audit does not run, and the AEO audit's category in it (issue #121).
      await client.callTool({
        name: "seo_audit_page",
        arguments: { html: "<title>x</title>", rules: ["title.too-lng"] },
      });
      await client.callTool({
        name: "seo_audit_page",
        arguments: { html: "<title>x</title>", rules: ["aeo"] },
      });
      await client.close();

      // The reason an expected error carries, from a fixed list (issue #123); none without one.
      expect(
        calls.map((c) => [c.tool, c.isError, c.errorType, c.properties?.reason])
      ).toStrictEqual([
        ["seo_audit_page", true, "validation", "target"],
        ["seo_audit_page", true, "validation", undefined],
        ["seo_audit_directory", true, "validation", undefined],
        ["seo_audit_page", true, "validation", "unknown_rules"],
        ["seo_audit_page", true, "validation", "other_audit_rules"],
      ]);
      expect(calls.map((c) => c.error)).toStrictEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
    });

    it("keeps an expected error's reason and cause, and a subclass's own reason (issue #123)", () => {
      const cause = new Error("the browser closed");

      expect(
        new ExpectedError("No browser.", { cause, reason: "browser" })
      ).toMatchObject({ message: "No browser.", cause, reason: "browser" });
      expect(new ExpectedError("No reason.").reason).toBeUndefined();
      expect(new CallLimitError("Too many calls.", "caller_calls").reason).toBe(
        "caller_calls"
      );
      expect(
        new RequestRefusedError(
          { message: "robots.txt", scope: "host", reason: "robots_txt" },
          "https://shop.example.com/"
        )
      ).toMatchObject({ reason: "robots_txt", scope: "host" });
    });

    it("keeps the tool's rule ids in an intent, and nothing that names a site (issue #84)", () => {
      expect(
        intentOf(
          "  fixed title.missing and img.alt-missing on shop.example.com, not title.missing.com  "
        )
      ).toBe("fixed title.missing and img.alt-missing on <host>, not <host>");
      // The text cannot write the mark a kept rule id waits behind.
      expect(intentOf("\uE0000\uE001 on shop.example.com")).toBe("0 on <host>");
      expect(intentOf("   ")).toBeUndefined();

      const long = intentOf("title.missing ".repeat(100));

      expect(long).toHaveLength(300);
      expect(long).not.toMatch(/[\uE000\uE001]/u);
    });

    it("keeps only the product token of a client's header", () => {
      expect(
        [
          "claude-user/1.0 (+https://claude.ai)",
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142",
          "https://tracker.example/me?id=42",
          "claude-code",
          "  ",
          undefined,
        ].map((value) => clientToken(value))
      ).toStrictEqual([
        "claude-user",
        "Mozilla",
        "https",
        "claude-code",
        undefined,
        undefined,
      ]);
    });

    it("sends the local server's calls as PostHog's MCP Analytics reads them, in one session", async () => {
      const sent: PostHogEvent[] = [];

      const client = await connect(
        localMcpAnalytics((events) => {
          sent.push(...events);

          return Promise.resolve(true);
        })
      );

      await client.callTool({
        name: "seo_audit_page",
        arguments: {
          html: "<html><head><title>Private title</title></head><body></body></html>",
        },
      });
      await client.close();

      const [start, call] = sent;
      assert(start && call, "an initialize and a call");

      expect(start.event).toBe("$mcp_initialize");
      expect(call).toMatchObject({
        event: "$mcp_tool_call",
        properties: {
          $mcp_source: "posthog_mcp_analytics",
          $mcp_server_name: "agentic-seo-check",
          $mcp_tool_name: "seo_audit_page",
          $mcp_resource_name: "seo_audit_page",
          $mcp_is_error: false,
          $mcp_client_name: "telemetry-test",
          $process_person_profile: false,
          $geoip_disable: true,
          surface: "local",
          os: process.platform,
          distinct_id: start.properties.distinct_id,
          $session_id: start.properties.distinct_id,
        },
      });
      expect(start.properties.distinct_id).toMatch(/^ses_/u);
      // A handshake counts no session: most connections call no tool.
      expect(start.properties).not.toHaveProperty("$session_id");
      expect(JSON.stringify(sent)).not.toContain("Private title");
    });
  });
});
