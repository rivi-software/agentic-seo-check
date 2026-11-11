import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, assert, describe, expect, it } from "vitest";

import {
  caughtError,
  ExpectedError,
  onCaughtError,
} from "../src/core/errors.js";
import { RequestRefusedError } from "../src/core/fetch.js";
import { LighthouseUnavailableError } from "../src/core/lighthouse.js";
import { RenderUnavailableError } from "../src/core/render.js";
import { fail, InputError } from "../src/mcp-shared.js";
import { LOCAL_TOOLS } from "../src/mcp.js";
import {
  cleanMessage,
  exceptionEvent,
  exceptionList,
  PACKAGE_PATH,
  reportable,
} from "../src/telemetry/exceptions.js";
import {
  cliErrorEvents,
  cliEvent,
  localMcpAnalytics,
  noteCliError,
  startCliRun,
} from "../src/telemetry/local.js";
import { instrumentTransport } from "../src/telemetry/mcp.js";
import type { PostHogEvent } from "../src/telemetry/posthog.js";

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

/** The local server's analytics on `server`, a client connected to it, and the events they send. */
const connect = async (server: McpServer) => {
  const sent: PostHogEvent[] = [];

  const analytics = localMcpAnalytics((event) => {
    sent.push(event);

    return Promise.resolve(true);
  });

  const client = new Client({ name: "error-tracking-test", version: "1.0.0" });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  instrumentTransport(serverTransport, analytics, LOCAL_TOOLS);
  await client.connect(clientTransport);

  return { analytics, client, sent };
};

const named = (events: PostHogEvent[], name: string) =>
  events.filter((event) => event.event === name);

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

    it("sends an error the core caught within a call, with the call's tool", async () => {
      const { analytics, client, sent } = await connect(
        oneTool(() => {
          caughtError(new RangeError("Invalid time value"));
          caughtError(new RenderUnavailableError("No browser"));

          return { content: [{ type: "text", text: "ok" }] };
        })
      );

      onCaughtError(analytics.caught);
      await client.callTool({ name: "seo_list_rules", arguments: {} });
      await client.close();

      const errors = named(sent, "$exception");

      expect(errors).toHaveLength(1);
      expect(errors[0]?.properties).toMatchObject({
        $mcp_tool_name: "seo_list_rules",
        $exception_list: [{ type: "RangeError", mechanism: { handled: true } }],
      });
    });

    it("sends an error nothing caught as unhandled, and waits for it", async () => {
      const sent: PostHogEvent[] = [];
      const timeouts: number[] = [];

      const analytics = localMcpAnalytics((event, timeoutMs) => {
        sent.push(event);
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
