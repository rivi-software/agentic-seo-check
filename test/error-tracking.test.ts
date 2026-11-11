import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { text as readAll } from "node:stream/consumers";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { auditAeoTarget } from "../src/core/aeo/audit.js";
import { auditSite } from "../src/core/audit.js";
import type { ProgressEvent } from "../src/core/audit.js";
import { InvalidPatternError } from "../src/core/crawl.js";
import {
  caughtError,
  ExpectedError,
  onCaughtError,
} from "../src/core/errors.js";
import type { CaughtErrorContext } from "../src/core/errors.js";
import { RequestRefusedError } from "../src/core/fetch.js";
import { extractPage } from "../src/core/html/extract.js";
import { LighthouseUnavailableError } from "../src/core/lighthouse.js";
import { RenderUnavailableError } from "../src/core/render.js";
import { PAGE_RULES, runPageRules } from "../src/core/rules/index.js";
import type { Rule } from "../src/core/rules/index.js";
import { DEFAULT_THRESHOLDS } from "../src/core/types.js";
import { fail, InputError } from "../src/mcp-shared.js";
import { createMcpServer, LOCAL_TOOLS } from "../src/mcp.js";
import {
  cleanMessage,
  exceptionEvent,
  exceptionEvents,
  exceptionList,
  MAX_EXCEPTIONS,
  PACKAGE_PATH,
  reportable,
} from "../src/telemetry/exceptions.js";
import type { ExceptionFrame } from "../src/telemetry/exceptions.js";
import {
  cliErrorEvents,
  cliEvent,
  localMcpAnalytics,
  MAX_SOURCE_MAP_BYTES,
  noteCliError,
  sourceFrames,
  startCliRun,
} from "../src/telemetry/local.js";
import { instrumentTransport } from "../src/telemetry/mcp.js";
import type { PostHogEvent } from "../src/telemetry/posthog.js";
import { siteRoutes, startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer } from "./helpers/fixture-server.js";

const ROOT = process.cwd();

/** An error whose stack is `frames`, as V8 writes them, below its own first line. */
const withStack = (error: Error, frames: string[]): Error => {
  error.stack = [`${error.name}: ${error.message}`, ...frames].join("\n");

  return error;
};

/** A server with one tool, `seo_list_rules`, that answers with `answer`. */
const oneTool = (answer: () => CallToolResult) => {
  const server = new McpServer({
    name: "error-tracking-test",
    version: "1.0.0",
  });

  server.registerTool(
    "seo_list_rules",
    { description: "Answers as the test says." },
    answer
  );

  return server;
};

/**
 * The local server's analytics on `server`, a client connected to it, and the events they send:
 * each request's in `batches`, and all of them in `sent`.
 */
const connect = async (server: McpServer) => {
  const sent: PostHogEvent[] = [];
  const batches: PostHogEvent[][] = [];

  const analytics = localMcpAnalytics((events) => {
    batches.push(events);
    sent.push(...events);

    return Promise.resolve(true);
  });

  const client = new Client({ name: "error-tracking-test", version: "1.0.0" });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  instrumentTransport(serverTransport, analytics, LOCAL_TOOLS);
  await client.connect(clientTransport);

  return { analytics, batches, client, sent };
};

const named = (events: PostHogEvent[], name: string) =>
  events.filter((event) => event.event === name);

/** Runs the CLI from source, and what it ends with. Telemetry is off (vitest.config.ts). */
const runCli = async (
  args: string[],
  options: { closeStdout?: boolean } = {}
): Promise<{ code: unknown; stderr: string }> => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "src", "cli.ts"), ...args],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );

  // A reader that stops at once, as `| head -c 0` does.
  if (options.closeStdout) {
    child.stdout.destroy();
  } else {
    child.stdout.resume();
  }

  const [stderr, [code]] = await Promise.all([
    readAll(child.stderr),
    once(child, "close"),
  ]);

  return { code, stderr };
};

/** A frame of the package's own code, as exceptions.ts reads one. */
const builtFrame = (overrides: Partial<ExceptionFrame>): ExceptionFrame => ({
  platform: "node:javascript",
  filename: "dist/core/audit.js",
  function: "run",
  lineno: 2,
  colno: 1,
  in_app: true,
  ...overrides,
});

/** An error of a rule's check, as `exceptionEvents` gets one. */
const thrownBy = (rule: string) => ({
  error: new TypeError("x is undefined"),
  handled: true,
  properties: { rule },
});

/** Throws in the crawl's own work on a post, as a bug of the extractor's would. */
const failOnPost = (event: ProgressEvent): void => {
  if (event.phase === "crawl" && event.url?.endsWith("/blog/post-1")) {
    throw new TypeError("Cannot read properties of null (reading 'tagName')");
  }
};

/** A directory standing in for the package, with `files` written under it. */
const packageWith = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(tmpdir(), "agentic-seo-check-maps-"));

  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }

  return root;
};

/**
 * A source map of `dist/core/a.js`: its line 2, column 1 is `src/core/a.ts`'s line 3, column 5, as
 * tsc writes one where a line of types above the code is erased.
 */
const sourceMap = (source = "../../src/core/a.ts") =>
  JSON.stringify({
    version: 3,
    file: "a.js",
    sources: [source],
    names: [],
    mappings: "AAAA;AAEI",
  });

describe("error tracking", () => {
  afterEach(() => {
    onCaughtError(undefined);
  });

  describe("a message", () => {
    it("loses URLs, paths, quoted text, hostnames and addresses", () => {
      expect(
        [
          'Target "https://shop.example.com/a?b=1" is not a URL, file or directory.',
          "fetch failed for https://shop.example.com/about",
          "ENOENT: no such file or directory, open '/Users/alice/site/index.html'",
          "Not a directory: /home/alice/dist",
          String.raw`Cannot read C:\Users\alice\baseline.json`,
          `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
          "getaddrinfo ENOTFOUND shop.example.com",
          "connect ECONNREFUSED 10.0.0.12:443",
          "No reply from alice@example.org",
          "The page says `Welcome to Alice's shop`",
        ].map((message) => cleanMessage(message))
      ).toStrictEqual([
        "Target <text> is not a URL, file or directory.",
        "fetch failed for <url>",
        "ENOENT: no such file or directory, open <text>",
        "Not a directory: <path>",
        "Cannot read <path>",
        "Unexpected token <text>, <text>... is not valid JSON",
        "getaddrinfo ENOTFOUND <host>",
        "connect ECONNREFUSED <ip>:443",
        "No reply from <email>",
        "The page says <text>",
      ]);
    });

    it("keeps what is code, such as a property's name", () => {
      expect(
        cleanMessage("Cannot read properties of undefined (reading 'href')")
      ).toBe("Cannot read properties of undefined (reading 'href')");
    });

    it("is cut to 300 characters, and reads a long one quickly", () => {
      const long = cleanMessage(`${"word ".repeat(100_000)}"never closed`);
      const started = performance.now();
      cleanMessage(`${"a".repeat(1_000_000)}`);

      expect(long).toHaveLength(300);
      expect(performance.now() - started).toBeLessThan(500);
    });
  });

  describe("a stack", () => {
    const home = homedir();

    const error = withStack(
      new TypeError("Cannot read properties of undefined (reading 'href')"),
      [
        `    at linkTargets (${path.join(ROOT, "src", "core", "crawl.ts")}:10:5)`,
        `    at async crawlSite (file://${ROOT}/dist/core/crawl.js:20:7)`,
        "    at parse (/home/alice/.npm/_npx/abc/node_modules/parse5/dist/index.js:3:4)",
        "    at run (/home/alice/.npm/_npx/abc/node_modules/@rivi-software/agentic-seo-check/dist/cli.js:5:6)",
        String.raw`    at C:\Users\alice\AppData\Local\pnpm\node_modules\.pnpm\zod@4.1.0\node_modules\zod\index.js:7:8`,
        "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
        `    at main (${path.join(home, "projects", "site", "build.js")}:9:10)`,
        "    at new Promise (<anonymous>)",
        "    at evalCode (eval at load (/home/alice/x.js:1:2), <anonymous>:1:1)",
        "    at page (https://shop.example.com/app.js:1:2)",
      ]
    );

    const [entry] = exceptionList(error, true);
    assert(entry?.stacktrace, "the error's frames");
    const { frames } = entry.stacktrace;

    it("names each file by its place in the package or in node_modules, the oldest call first", () => {
      expect(
        frames.map((frame) => [frame.filename, frame.function, frame.in_app])
      ).toStrictEqual([
        ["<unknown>", "page", false],
        ["<eval>", "evalCode", false],
        ["<anonymous>", "new Promise", false],
        ["build.js", "main", false],
        [
          "node:internal/process/task_queues",
          "process.processTicksAndRejections",
          false,
        ],
        ["node_modules/zod/index.js", "?", false],
        ["dist/cli.js", "run", true],
        ["node_modules/parse5/dist/index.js", "parse", false],
        ["dist/core/crawl.js", "crawlSite", true],
        ["src/core/crawl.ts", "linkTargets", true],
      ]);
      expect(frames.at(-1)).toMatchObject({
        platform: "node:javascript",
        lineno: 10,
        colno: 5,
      });
    });

    it("never names a directory above the package, nor a URL", () => {
      const json = JSON.stringify(frames);

      expect(json).not.toContain(home);
      expect(json).not.toContain(ROOT);
      expect(json).not.toMatch(/alice|Users|shop\.example/u);
    });

    it("finds the package where npm puts it", () => {
      // SAFETY: npm refuses to pack a package.json without a string name.
      const manifest = JSON.parse(
        readFileSync(path.join(ROOT, "package.json"), "utf-8")
      ) as { name: string };

      expect(PACKAGE_PATH).toBe(`${manifest.name}/`);
    });

    it("reads no frame out of a message changed after V8 wrote the stack", () => {
      const changed = new Error(
        "Bad page\n    at Alice Smith lives here (shop.example.com:1:2)"
      );

      // V8 writes the stack when it is first read; a library then rewrites the message.
      void changed.stack;
      changed.message = "Bad page";

      const [first] = exceptionList(changed, true);
      const json = JSON.stringify(first);

      expect(json).not.toMatch(/Alice|shop\.example/u);
    });

    it("takes no hostname for a folder of a file", () => {
      const changed = new Error(
        "Bad page\n    at x (shop.example.com/u/bob.js:1:2)"
      );

      void changed.stack;
      changed.message = "Bad page";

      expect(JSON.stringify(exceptionList(changed, true))).not.toContain(
        "shop.example"
      );
    });

    it("reads no frame out of the message", () => {
      const sneaky = new Error(
        "Bad page\n    at secret (https://shop.example.com/x.js:1:2)"
      );

      const [first] = exceptionList(sneaky, true);

      expect(JSON.stringify(first?.stacktrace?.frames)).not.toContain("secret");
    });
  });

  it("lists the error, then its causes, as PostHog chains them", () => {
    const cause = new RangeError("Invalid time value");
    const error = new Error("Could not build the report", { cause });

    expect(
      exceptionList(error, false).map((entry) => [
        entry.type,
        entry.value,
        entry.mechanism,
      ])
    ).toStrictEqual([
      [
        "Error",
        "Could not build the report",
        { type: "generic", handled: false, synthetic: false, exception_id: 0 },
      ],
      [
        "RangeError",
        "Invalid time value",
        {
          type: "chained",
          source: "cause",
          synthetic: false,
          exception_id: 1,
          parent_id: 0,
        },
      ],
    ]);
  });

  it("leaves out what is no bug: the caller's input, a refusal, a missing browser, a timeout", () => {
    const timeout = Object.assign(new Error("The operation timed out."), {
      name: "TimeoutError",
    });

    expect(
      [
        new ExpectedError("Not a directory: x"),
        new InputError("Provide `url` or `html`."),
        new RequestRefusedError(
          { message: "robots.txt", scope: "url" },
          "https://a.example/"
        ),
        new RenderUnavailableError("No browser"),
        new LighthouseUnavailableError("No Lighthouse"),
        timeout,
        new TypeError("x is not a function"),
        "a thrown string",
      ].map((error) => reportable(error))
    ).toStrictEqual([false, false, false, false, false, false, true, true]);
  });

  it("builds no event out of a value it cannot read", () => {
    expect(
      exceptionEvent(Object.create(null), {
        distinctId: "d",
        handled: true,
        surface: "cli",
      })
    ).toBeUndefined();
  });

  describe("the CLI", () => {
    it("sends a run's errors beside its cli_command, with the run's id", () => {
      const run = startCliRun("audit", ["--render"]);
      run.target = "url";
      run.format = "json";

      noteCliError(run, new TypeError("a.links is undefined"), true);
      noteCliError(run, new InputError("Provide a target."), false);
      noteCliError(
        run,
        withStack(new Error("Crashed on https://shop.example.com/"), [
          `    at main (${path.join(tmpdir(), "x", "cli.js")}:1:1)`,
        ]),
        false
      );

      const events = cliErrorEvents(run);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        event: "$exception",
        properties: {
          distinct_id: cliEvent(run, 2).properties.distinct_id,
          surface: "cli",
          command: "audit",
          flags: ["--render"],
          target: "url",
          format: "json",
          occurrences: 1,
          os: process.platform,
          $process_person_profile: false,
          $exception_level: "error",
          $exception_list: [
            {
              type: "TypeError",
              value: "<host> is undefined",
              mechanism: { handled: true },
            },
          ],
        },
      });
      expect(JSON.stringify(events)).not.toMatch(
        /shop\.example|Provide a target/u
      );
      expect(JSON.stringify(events)).not.toContain(tmpdir());
    });

    it("names the rule whose check threw", () => {
      const run = startCliRun("crawl", []);

      noteCliError(run, new TypeError("x is undefined"), true, {
        rule: "title.missing",
      });

      expect(cliErrorEvents(run)[0]?.properties.rule).toBe("title.missing");
    });

    it("exits with 2 and the reason for a report it cannot write", async () => {
      const missing = path.join(tmpdir(), "agentic-seo-check-none", "r.md");

      const { code, stderr } = await runCli([
        "audit",
        "test/fixtures/good-page.html",
        "-q",
        "-o",
        missing,
      ]);

      expect(code).toBe(2);
      expect(stderr).toContain(`Cannot write the report to ${missing}`);
    });

    it("exits with 2 and the reason for a pattern that is no regular expression, before any request", async () => {
      const { code, stderr } = await runCli([
        "crawl",
        "http://127.0.0.1:9/",
        "--include",
        "(",
        "-q",
      ]);

      expect(code).toBe(2);
      expect(stderr).toContain(
        'The include pattern "(" is not a valid regular expression'
      );
    });

    it("ends quietly, with the run's own exit code, when the reader closes the pipe", async () => {
      const { code, stderr } = await runCli(["rules", "-f", "json"], {
        closeStdout: true,
      });

      expect(stderr).not.toMatch(/EPIPE|\n\s+at /u);
      expect(code).toBe(0);
    });
  });

  describe("one bug", () => {
    const context = { distinctId: "d", surface: "cli" as const };

    it("is one event, however often a run meets it", () => {
      const errors = Array.from({ length: 500 }, () => ({
        error: new TypeError(
          "Cannot read properties of undefined (reading 'href')"
        ),
        handled: true,
        properties: { rule: "links.empty" },
      }));

      const events = exceptionEvents(errors, context);

      expect(events).toHaveLength(1);
      expect(events[0]?.properties).toMatchObject({
        rule: "links.empty",
        occurrences: 500,
        $exception_list: [{ mechanism: { handled: true } }],
      });
    });

    it("is not another rule's, nor another place's", () => {
      const events = exceptionEvents(
        [
          thrownBy("title.missing"),
          thrownBy("title.missing"),
          thrownBy("meta.description-missing"),
          { error: new TypeError("x is undefined"), handled: true },
        ],
        context
      );

      expect(
        events.map((event) => [
          event.properties.rule,
          event.properties.occurrences,
        ])
      ).toStrictEqual([
        ["title.missing", 2],
        ["meta.description-missing", 1],
        [undefined, 1],
      ]);
    });

    it("sends ten bugs at most, and nothing for what is no bug", () => {
      const errors = Array.from({ length: 30 }, (_, index) => ({
        error: new RangeError(`Failure number ${index}`),
        handled: true,
      }));

      expect(exceptionEvents(errors, context)).toHaveLength(MAX_EXCEPTIONS);
      expect(
        exceptionEvents(
          [{ error: new ExpectedError("Not a directory"), handled: false }],
          context
        )
      ).toStrictEqual([]);
    });
  });

  describe("a frame of the build", () => {
    it("is named by its TypeScript source, from the map beside it", () => {
      const root = packageWith({ "dist/core/a.js.map": sourceMap() });

      expect(
        sourceFrames(root)(builtFrame({ filename: "dist/core/a.js" }))
      ).toMatchObject({
        filename: "src/core/a.ts",
        lineno: 3,
        colno: 5,
        function: "run",
        in_app: true,
      });
    });

    it("keeps its place in the build without a map, or with one that points outside src/", () => {
      const root = packageWith({
        "dist/core/b.js.map": sourceMap("../../../etc/b.ts"),
        "dist/core/c.js.map": "not a map",
      });

      const map = sourceFrames(root);

      for (const filename of [
        "dist/core/a.js",
        "dist/core/b.js",
        "dist/core/c.js",
      ]) {
        expect(map(builtFrame({ filename }))).toStrictEqual(
          builtFrame({ filename })
        );
      }
    });

    it("reads no map but its own, and none too large", () => {
      const root = packageWith({
        "node_modules/x/dist/a.js.map": sourceMap(),
        "dist/a.js.map": sourceMap(),
        "dist/big.js.map": " ".repeat(MAX_SOURCE_MAP_BYTES + 1),
      });

      const map = sourceFrames(root);

      const outside = [
        builtFrame({ filename: "node_modules/x/dist/a.js", in_app: false }),
        builtFrame({ filename: "dist/../dist/a.js" }),
        builtFrame({ filename: "index.js" }),
        builtFrame({ filename: "dist/a.js", in_app: false }),
        builtFrame({ filename: "dist/big.js" }),
      ];

      expect(outside.map((f) => map(f))).toStrictEqual(outside);
    });

    it("is mapped in a run's events", () => {
      const run = startCliRun("audit", []);

      noteCliError(run, new TypeError("x is undefined"), true);

      const [event] = cliErrorEvents(run, (f) => ({
        ...f,
        filename: "src/mapped.ts",
      }));

      expect(JSON.stringify(event)).toContain('"filename":"src/mapped.ts"');
    });
  });

  describe("the core", () => {
    it("reports a rule that throws, with its id, and still gives the user its finding", () => {
      const heard: { error: unknown; context: CaughtErrorContext }[] = [];

      const [model] = PAGE_RULES;
      assert(model, "a page rule");

      const throws: Rule = {
        meta: { ...model.meta, id: "test.throws" },
        check: () => {
          throw new TypeError(
            "Cannot read properties of undefined (reading 'src')"
          );
        },
      };

      onCaughtError((thrown, context) =>
        heard.push({ error: thrown, context })
      );

      const findings = runPageRules(
        {
          page: extractPage("<title>A page</title>", {
            url: "https://www.example.com/",
          }),
          source: "url",
          thresholds: DEFAULT_THRESHOLDS,
        },
        { rules: [throws] }
      );

      expect(findings.map((f) => f.rule)).toStrictEqual(["tool.rule-error"]);
      expect(heard).toHaveLength(1);
      expect(heard[0]?.context).toStrictEqual({ rule: "test.throws" });
      expect(heard[0]?.error).toBeInstanceOf(TypeError);
    });
  });

  describe("a crawl", () => {
    let server: FixtureServer;

    beforeAll(async () => {
      server = await startFixtureServer(siteRoutes());
    });

    afterAll(async () => {
      await server.close();
    });

    it("tells the user and error tracking of a page it left out", async () => {
      const heard: unknown[] = [];

      onCaughtError((thrown) => heard.push(thrown));

      const site = await auditSite(server.origin, { onProgress: failOnPost });

      const failed = site.siteFindings.find(
        (f) => f.rule === "tool.page-error"
      );

      expect(site.pages.map((p) => p.url)).not.toContain(
        `${server.origin}/blog/post-1`
      );
      expect(failed).toMatchObject({
        severity: "info",
        category: "tool",
        fix: [],
        evidence: {
          count: 1,
          pages: [
            {
              url: `${server.origin}/blog/post-1`,
              error: "Cannot read properties of null (reading 'tagName')",
            },
          ],
        },
      });
      expect(heard).toHaveLength(1);
    });

    it("tells the user in the AEO audit too", async () => {
      const aeo = await auditAeoTarget(server.origin, {
        crawl: true,
        onProgress: failOnPost,
      });

      expect(aeo.findings.map((f) => f.rule)).toContain("tool.page-error");
    });

    it("refuses a pattern that is no regular expression, as the caller's mistake", async () => {
      const refusal = auditSite(server.origin, { excludePatterns: ["[a-"] });

      await expect(refusal).rejects.toBeInstanceOf(InvalidPatternError);
      await expect(refusal).rejects.toThrow(
        'The exclude pattern "[a-" is not a valid regular expression'
      );
      expect(reportable(new InvalidPatternError("x"))).toBeFalsy();
    });
  });

  describe("the local MCP server", () => {
    it("sends an internal failure's error in the call's session, and never its message as it was", async () => {
      const { client, sent } = await connect(
        oneTool(() =>
          fail(new TypeError("Could not read https://shop.example.com/about"))
        )
      );

      await client.callTool({ name: "seo_list_rules", arguments: {} });
      await client.close();

      const [call] = named(sent, "$mcp_tool_call");
      const [error] = named(sent, "$exception");
      assert(call && error, "the call's event and its error's");

      expect(call.properties).toMatchObject({
        $mcp_is_error: true,
        $mcp_error_type: "internal",
      });
      expect(error.properties).toMatchObject({
        surface: "local",
        $mcp_tool_name: "seo_list_rules",
        $session_id: call.properties.$session_id,
        distinct_id: call.properties.distinct_id,
        $exception_list: [{ type: "TypeError", value: "Could not read <url>" }],
      });
      expect(JSON.stringify(sent)).not.toContain("shop.example.com");
    });

    it("sends nothing for a rule id the caller mistyped", async () => {
      const { client, sent } = await connect(createMcpServer());

      await client.callTool({
        name: "seo_audit_page",
        arguments: {
          html: "<html><head><title>A page</title></head><body></body></html>",
          rules: ["title.too-lng"],
        },
      });
      await client.close();

      expect(named(sent, "$exception")).toStrictEqual([]);
      expect(named(sent, "$mcp_tool_call")[0]?.properties).toMatchObject({
        $mcp_is_error: true,
        $mcp_error_type: "validation",
      });
    });

    it("sends nothing for a failure the tool expects", async () => {
      const { client, sent } = await connect(
        oneTool(() => fail(new ExpectedError("Not a directory: no/such/dir")))
      );

      await client.callTool({ name: "seo_list_rules", arguments: {} });
      await client.close();

      expect(named(sent, "$exception")).toStrictEqual([]);
      expect(named(sent, "$mcp_tool_call")[0]?.properties).toMatchObject({
        $mcp_error_type: "validation",
      });
    });

    it("sends the errors the core caught within a call with the call's event, one per bug", async () => {
      const { analytics, batches, client } = await connect(
        oneTool(() => {
          for (let page = 0; page < 3; page += 1) {
            caughtError(new RangeError("Invalid time value"), {
              rule: "meta.date",
            });
          }

          caughtError(new RenderUnavailableError("No browser"));

          return { content: [{ type: "text", text: "ok" }] };
        })
      );

      onCaughtError(analytics.caught);
      await client.callTool({ name: "seo_list_rules", arguments: {} });
      await client.close();

      const batch = batches.find(
        (events) => named(events, "$mcp_tool_call").length > 0
      );

      assert(batch, "the call's request");

      expect(batch.map((event) => event.event)).toStrictEqual([
        "$mcp_tool_call",
        "$exception",
      ]);
      expect(batch[1]?.properties).toMatchObject({
        $mcp_tool_name: "seo_list_rules",
        $session_id: batch[0]?.properties.$session_id,
        rule: "meta.date",
        occurrences: 3,
        $exception_list: [{ type: "RangeError", mechanism: { handled: true } }],
      });
    });

    it("sends an error nothing caught as unhandled, and waits for it", async () => {
      const sent: PostHogEvent[] = [];
      const timeouts: number[] = [];

      const analytics = localMcpAnalytics((events, timeoutMs) => {
        sent.push(...events);
        timeouts.push(timeoutMs);

        return Promise.resolve(true);
      });

      await analytics.crashed(new Error("socket hang up"));

      expect(sent[0]?.properties).toMatchObject({
        surface: "local",
        $exception_list: [{ mechanism: { handled: false } }],
      });
      expect(timeouts).toStrictEqual([1000]);
    });
  });
});
