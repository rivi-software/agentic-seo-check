/**
 * Telemetry of the CLI and the local MCP server (issue #57). It is on unless the user turns it off,
 * and the first run says so on stderr. Nothing identifies the user: no id is stored, so two runs
 * cannot be linked, and an event carries no URL, hostname, path or anything from a page. Only
 * cli.ts and mcp-bin.ts import this module; the library and the hosted server never send.
 */
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { PRODUCT_NAME, REPOSITORY_URL } from "../brand.js";
import { resolveTarget } from "../core/audit.js";
import { onCaughtError } from "../core/errors.js";
import type { CaughtErrorContext } from "../core/errors.js";
import type { OutputFormat } from "../terminal.js";
import { exceptionEvents } from "./exceptions.js";
import type { FrameMapper, ReportedError } from "./exceptions.js";
import {
  currentTool,
  initializeEvent,
  noteCaughtInCall,
  toolCallEvent,
} from "./mcp.js";
import type {
  CaughtInCall,
  McpAnalytics,
  McpEventContext,
  McpToolCall,
} from "./mcp.js";
import { BASE_PROPERTIES, sendEvents, uuidv7 } from "./posthog.js";
import type { PostHogEvent } from "./posthog.js";
import type { RunReport } from "./report.js";

/** The variable that turns telemetry off: 0, false, off or no. */
export const TELEMETRY_ENV = "AGENTIC_SEO_CHECK_TELEMETRY";

export const TELEMETRY_DOCS = `${REPOSITORY_URL}#telemetry`;

export const NOTICE = `${PRODUCT_NAME} sends anonymous usage data to RIVI Software (PostHog, EU): the command, the names of the flags, the kind of target, the exit code, the number of pages and findings, the rules that fired, and the type and stack of an unexpected error. Never a URL, a hostname, a path or anything from a page. Turn it off with \`agentic-seo-check telemetry disable\` or DO_NOT_TRACK=1. ${TELEMETRY_DOCS}`;

/**
 * Which NOTICE the user last saw: 1 said nothing of errors (issue #57), 2 does (issue #60). A user
 * who saw an older one sees the new one once.
 */
export const NOTICE_VERSION = 2;

type Env = Record<string, string | undefined>;

const OFF = new Set(["0", "false", "off", "no"]);

const isOff = (value: string | undefined): boolean =>
  value !== undefined && OFF.has(value.trim().toLowerCase());

/** Set to anything but empty or one of the OFF words. */
const isOn = (value: string | undefined): boolean =>
  Boolean(value?.trim()) && !isOff(value);

/**
 * Where the user's choice is kept: their config directory, as XDG and Windows place it. `home` is
 * asked only when neither variable names one: os.homedir() throws where there is no HOME and the
 * user has no passwd entry, as in containers that run under an arbitrary UID.
 */
export const settingsPath = (
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home: () => string = homedir
): string => {
  const windows = () => env.APPDATA || path.join(home(), "AppData", "Roaming");

  const base =
    env.XDG_CONFIG_HOME ||
    (platform === "win32" ? windows() : path.join(home(), ".config"));

  return path.join(base, "agentic-seo-check", "telemetry.json");
};

const SettingsSchema = z.object({
  /** The user's choice; telemetry is on when they made none. */
  enabled: z.boolean().optional(),
  /** The day the first-run notice was shown. */
  noticeShown: z.string().optional(),
  /** Which notice that was (NOTICE_VERSION); a file without it saw the first. */
  noticeVersion: z.number().optional(),
});

type Settings = z.infer<typeof SettingsSchema>;

const readSettings = async (file: string): Promise<Settings> => {
  try {
    return SettingsSchema.parse(JSON.parse(await readFile(file, "utf-8")));
  } catch {
    return {};
  }
};

const writeSettings = async (
  file: string,
  settings: Settings
): Promise<boolean> => {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");

    return true;
  } catch {
    return false;
  }
};

/** Why the environment turns telemetry off, or null when it does not. */
export const offByEnv = (env: Env = process.env): string | null => {
  if (isOn(env.DO_NOT_TRACK)) {
    return "DO_NOT_TRACK is set";
  }

  if (isOff(env[TELEMETRY_ENV])) {
    return `${TELEMETRY_ENV} is ${env[TELEMETRY_ENV]}`;
  }

  return isOn(env.CI) ? "CI is set" : null;
};

export interface TelemetryStatus {
  enabled: boolean;
  /** Why it is on or off, as `telemetry status` says it. */
  reason: string;
  /** The settings file. */
  file: string;
  settings: Settings;
}

export const telemetryStatus = async (
  env: Env = process.env,
  home: () => string = homedir
): Promise<TelemetryStatus> => {
  const file = settingsPath(env, process.platform, home);
  const settings = await readSettings(file);
  const byEnv = offByEnv(env);

  if (byEnv) {
    return { enabled: false, reason: byEnv, file, settings };
  }

  return settings.enabled === false
    ? {
        enabled: false,
        reason: "turned off with `agentic-seo-check telemetry disable`",
        file,
        settings,
      }
    : {
        enabled: true,
        reason:
          "anonymous usage data goes to RIVI Software's PostHog project (EU)",
        file,
        settings,
      };
};

/**
 * Whether this run sends telemetry. The first time it does, the notice goes to stderr (never
 * stdout, which carries the report or the MCP server's JSON-RPC), and the settings file records
 * that it was shown. When the file cannot be written, the notice is shown again next time.
 */
export const prepareTelemetry = async (
  options: {
    env?: Env;
    stderr?: Pick<NodeJS.WriteStream, "write">;
    /** os.homedir(), or what stands in for it in the tests. */
    home?: () => string;
  } = {}
): Promise<boolean> => {
  let status: TelemetryStatus;

  try {
    status = await telemetryStatus(options.env, options.home);
  } catch {
    // No directory to keep the choice in: telemetry never stops the CLI or the server, so it is off.
    return false;
  }

  if (!status.enabled) {
    return false;
  }

  const seen = status.settings.noticeShown
    ? (status.settings.noticeVersion ?? 1)
    : 0;

  if (seen < NOTICE_VERSION) {
    (options.stderr ?? process.stderr).write(`${NOTICE}\n`);

    await writeSettings(status.file, {
      ...status.settings,
      noticeShown: new Date().toISOString().slice(0, 10),
      noticeVersion: NOTICE_VERSION,
    });
  }

  return true;
};

/** `agentic-seo-check telemetry [status|enable|disable]`: what it prints. */
export const telemetryCommand = async (
  action: "status" | "enable" | "disable",
  env: Env = process.env
): Promise<string> => {
  const file = settingsPath(env);

  if (action !== "status") {
    const settings = await readSettings(file);

    if (
      !(await writeSettings(file, {
        ...settings,
        enabled: action === "enable",
      }))
    ) {
      throw new Error(`Could not write ${file}.`);
    }
  }

  const status = await telemetryStatus(env);

  return `Telemetry is ${status.enabled ? "on" : "off"}: ${status.reason}.\nThe choice is kept in ${status.file}.\nWhat is sent and why: ${TELEMETRY_DOCS}\n`;
};

/** The machine an event comes from, as far as it says nothing about who uses it. */
const environment = () => ({
  os: process.platform,
  node_major: Number(process.versions.node.split(".")[0]),
});

/** What the audit was run on, never which one. */
export type TargetKind = "url" | "localhost" | "directory" | "file" | "stdin";

const LOCAL_HOST =
  /^(?:localhost|[\w.-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/iu;

export const targetKind = async (
  target: string
): Promise<TargetKind | undefined> => {
  try {
    const resolved = await resolveTarget(target);

    if (resolved.kind !== "url") {
      return resolved.kind;
    }

    return LOCAL_HOST.test(new URL(resolved.url).hostname)
      ? "localhost"
      : "url";
  } catch {
    return undefined;
  }
};

/** An error a run met, for its `$exception` event (issue #60). */
interface RunError {
  error: unknown;
  /** False when only the CLI's last resort caught it. */
  handled: boolean;
  /** The rule whose check threw, when one did (issue #85). */
  rule?: string;
}

/** One run of a CLI command, as its events tell it. */
export interface CliRun {
  /** The run's id, new each run: its `cli_command` and its errors share it, and nothing else does. */
  id: string;
  command: string;
  /** The names of the flags the user gave, such as `--crawl`; never their values. */
  flags: readonly string[];
  startedAt: Date;
  started: number;
  target?: TargetKind;
  /** The report's format: whether a person (`text`) or a program (`json`) reads the run. */
  format?: OutputFormat;
  report?: RunReport;
  errors: RunError[];
}

export const startCliRun = (
  command: string,
  flags: readonly string[]
): CliRun => ({
  id: uuidv7(),
  command,
  flags,
  startedAt: new Date(),
  started: performance.now(),
  errors: [],
});

/** The most errors a run keeps for its events: a rule that throws on every page of a crawl is one bug. */
const MAX_RUN_ERRORS = 1000;

/** Notes an error of `run`, for its `$exception` event; `sendCliRun` leaves out what is no bug. */
export const noteCliError = (
  run: CliRun,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until exceptions.ts reads it
  error: unknown,
  handled: boolean,
  context: CaughtErrorContext = {}
): void => {
  if (run.errors.length < MAX_RUN_ERRORS) {
    run.errors.push({ error, handled, rule: context.rule });
  }
};

/** A run's `cli_command` event, with the run's id: no two runs can be linked. */
export const cliEvent = (run: CliRun, exitCode: number): PostHogEvent => ({
  event: "cli_command",
  timestamp: run.startedAt.toISOString(),
  properties: {
    ...BASE_PROPERTIES,
    distinct_id: run.id,
    surface: "cli",
    command: run.command,
    flags: run.flags,
    target: run.target,
    format: run.format,
    exit_code: exitCode,
    duration_ms: Math.round(performance.now() - run.started),
    pages: run.report?.pages,
    errors: run.report?.counts.error,
    warnings: run.report?.counts.warning,
    infos: run.report?.counts.info,
    rules: run.report?.rules,
    ...environment(),
  },
});

/** The longest a run waits for its event to be sent, after its output is written. */
export const CLI_SEND_TIMEOUT_MS = 1000;

/** The package's directory, from this module's place in it (src/telemetry/ or dist/telemetry/). */
const packageDirectory = (): string | undefined => {
  try {
    return fileURLToPath(new URL("../../", import.meta.url));
  } catch {
    return undefined;
  }
};

/** The most of a source map that is read: tsc's largest in dist/ is a tenth of it. */
export const MAX_SOURCE_MAP_BYTES = 1_000_000;

/** A file of the build, by its place in the package: `dist/`, then plain names, never `..`. */
const BUILT_FILE = /^dist\/(?:[\w-]+\/)*[\w.-]+\.js$/u;

/** A file of the source, as a map of the build names it. */
const SOURCE_FILE = /^src\/(?:[\w-]+\/)*[\w.-]+\.ts$/u;

/** The source maps read in this process, by file; null for one that is missing or unreadable. */
const sourceMaps = new Map<string, SourceMap | null>();

const sourceMapOf = (root: string, file: string): SourceMap | null => {
  const where = path.join(root, `${file}.map`);
  const known = sourceMaps.get(where);

  if (known !== undefined) {
    return known;
  }

  let map: SourceMap | null = null;

  try {
    if (statSync(where).size <= MAX_SOURCE_MAP_BYTES) {
      map = new SourceMap(JSON.parse(readFileSync(where, "utf-8")));
    }
  } catch {
    // No map, or one that is no source map: the frame keeps its place in the build.
  }

  sourceMaps.set(where, map);

  return map;
};

/**
 * Names a frame of the build by its TypeScript source, through the `.map` file tsc wrote beside it
 * (issue #85): `dist/core/audit.js:331:13` becomes the line in `src/core/audit.ts` that the release's
 * tag holds. Only the package's own files are read, and only their maps; a frame without a map, or
 * whose map names a file outside `src/`, keeps its place in the build.
 */
export const sourceFrames =
  (root: string | undefined = packageDirectory()): FrameMapper =>
  (frame) => {
    if (
      !(root && frame.in_app && BUILT_FILE.test(frame.filename)) ||
      frame.lineno === undefined ||
      frame.colno === undefined
    ) {
      return frame;
    }

    try {
      const origin = sourceMapOf(root, frame.filename)?.findOrigin(
        frame.lineno,
        frame.colno
      );

      if (!(origin && "fileName" in origin)) {
        return frame;
      }

      const source = path.posix.normalize(
        path.posix.join(path.posix.dirname(frame.filename), origin.fileName)
      );

      return SOURCE_FILE.test(source)
        ? {
            ...frame,
            filename: source,
            lineno: origin.lineNumber,
            colno: origin.columnNumber,
          }
        : frame;
    } catch {
      return frame;
    }
  };

/**
 * The `$exception` events of a run's errors, beside its `cli_command`: one per bug, with what the
 * run was (issue #85). `cli_command` carries the same flags, target and format.
 */
export const cliErrorEvents = (
  run: CliRun,
  mapFrame: FrameMapper = sourceFrames()
): PostHogEvent[] =>
  exceptionEvents(
    run.errors.map(({ error, handled, rule }) => ({
      error,
      handled,
      properties: { rule },
    })),
    {
      distinctId: run.id,
      surface: "cli",
      mapFrame,
      properties: {
        command: run.command,
        flags: run.flags,
        target: run.target,
        format: run.format,
        ...environment(),
      },
    }
  );

/** Sends a run's event and its errors' in one request. */
export const sendCliRun = (run: CliRun, exitCode: number): Promise<boolean> =>
  sendEvents([cliEvent(run, exitCode), ...cliErrorEvents(run)], {
    timeoutMs: CLI_SEND_TIMEOUT_MS,
  });

/**
 * Takes over from Node when an error nothing caught would end the process: writes its stack to
 * stderr as Node does, gives `report` a second at most to send it, and exits with 1, as Node does.
 * A second such error while the first is sent ends the process at once.
 */
export const reportCrashes = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until exceptions.ts reads it
  report: (error: unknown) => Promise<void>
): void => {
  let crashed = false;

  const crash = async (thrown: Error): Promise<void> => {
    process.stderr.write(`${thrown.stack ?? String(thrown)}\n`);

    if (!crashed) {
      crashed = true;
      await report(thrown);
    }

    process.exit(1);
  };

  process.on("uncaughtException", (thrown) => {
    void crash(thrown);
  });
};

/** A session of the local MCP server ends after this long without a call, as PostHog's docs say. */
const IDLE_MS = 30 * 60_000;

/** The local MCP server's analytics, and its error tracking (issue #60). */
export interface LocalMcpAnalytics extends McpAnalytics {
  /** An error the core caught and turned into a finding: sent with the call it happened in. */
  caught: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until exceptions.ts reads it
    error: unknown,
    context: CaughtErrorContext
  ) => void;
  /** An error nothing caught: resolves once its event is sent, or given up after a second. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- as above
  crashed: (error: unknown) => Promise<void>;
}

/** Errors' events on the local MCP server, one per bug, in the session and the call they happened in. */
const localErrorEvents = (
  errors: ReportedError[],
  where: McpEventContext,
  tool: string | undefined
): PostHogEvent[] =>
  exceptionEvents(errors, {
    distinctId: where.sessionId,
    sessionId: where.sessionId,
    surface: "local",
    mapFrame: sourceFrames(),
    properties: { $mcp_tool_name: tool, ...where.properties },
  });

const caughtErrors = (caught: readonly CaughtInCall[] = []): ReportedError[] =>
  caught.map(({ error, rule }) => ({
    error,
    handled: true,
    properties: { rule },
  }));

/**
 * The local MCP server's analytics. A stdio connection is one client, so its calls share a
 * session, until a call comes after half an hour without one: a long-running server serves many
 * chats. A call's errors go in one request with its event. `send` is for the tests; it gets how
 * long the send may take.
 */
export const localMcpAnalytics = (
  send: (events: PostHogEvent[], timeoutMs: number) => Promise<boolean> = (
    events,
    timeoutMs
  ) => sendEvents(events, { timeoutMs })
): LocalMcpAnalytics => {
  let sessionId = `ses_${uuidv7()}`;
  let last = Date.now();

  const context = (): McpEventContext => {
    const now = Date.now();

    if (now - last >= IDLE_MS) {
      sessionId = `ses_${uuidv7(now)}`;
    }

    last = now;

    return { sessionId, surface: "local", properties: environment() };
  };

  // The server keeps running: events are sent alongside the next call, never in its way.
  const later = (events: PostHogEvent[]): void => {
    if (events.length > 0) {
      void send(events, 5000);
    }
  };

  return {
    initialize: (caller) => later([initializeEvent(caller, context())]),
    toolCall: (call: McpToolCall) => {
      const where = context();

      const errors = caughtErrors(call.caught);

      if (call.error !== undefined) {
        errors.push({ error: call.error, handled: true });
      }

      later([
        toolCallEvent(call, where),
        ...localErrorEvents(errors, where, call.tool),
      ]);
    },
    caught: (error, caughtContext) => {
      // Within a call, it waits for the call's event; outside one, it has no call to wait for.
      if (!noteCaughtInCall(error, caughtContext)) {
        later(
          localErrorEvents(
            caughtErrors([{ ...caughtContext, error }]),
            context(),
            currentTool()
          )
        );
      }
    },
    crashed: async (error) => {
      const events = localErrorEvents(
        [{ error, handled: false }],
        context(),
        currentTool()
      );

      if (events.length > 0) {
        await send(events, CLI_SEND_TIMEOUT_MS);
      }
    },
  };
};

/**
 * The local MCP server's telemetry, for `agentic-seo-check mcp` and agentic-seo-check-mcp: its
 * analytics, the errors the core catches, and the ones nothing does. Undefined while it is off.
 */
export const localMcpTelemetry = async (): Promise<
  LocalMcpAnalytics | undefined
> => {
  if (!(await prepareTelemetry())) {
    return undefined;
  }

  const analytics = localMcpAnalytics();

  onCaughtError(analytics.caught);
  reportCrashes(analytics.crashed);

  return analytics;
};
