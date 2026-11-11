/**
 * Telemetry of the CLI and the local MCP server (issue #57). It is on unless the user turns it off,
 * and the first run says so on stderr. Nothing identifies the user: no id is stored, so two runs
 * cannot be linked, and an event carries no URL, hostname, path or anything from a page. Only
 * cli.ts and mcp-bin.ts import this module; the library and the hosted server never send.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { PRODUCT_NAME, REPOSITORY_URL } from "../brand.js";
import { resolveTarget } from "../core/audit.js";
import type { AeoAudit, Audit, SeverityCounts } from "../core/types.js";
import { initializeEvent, toolCallEvent } from "./mcp.js";
import type { McpAnalytics, McpEventContext } from "./mcp.js";
import { BASE_PROPERTIES, sendEvents, uuidv7 } from "./posthog.js";
import type { PostHogEvent } from "./posthog.js";

/** The variable that turns telemetry off: 0, false, off or no. */
export const TELEMETRY_ENV = "AGENTIC_SEO_CHECK_TELEMETRY";

export const TELEMETRY_DOCS = `${REPOSITORY_URL}#telemetry`;

export const NOTICE = `${PRODUCT_NAME} sends anonymous usage data to RIVI Software (PostHog, EU): the command, the names of the flags, the kind of target, the exit code, the number of pages and findings, and the rules that fired. Never a URL, a hostname, a path or anything from a page. Turn it off with \`agentic-seo-check telemetry disable\` or DO_NOT_TRACK=1. ${TELEMETRY_DOCS}`;

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

  if (!status.settings.noticeShown) {
    (options.stderr ?? process.stderr).write(`${NOTICE}\n`);

    await writeSettings(status.file, {
      ...status.settings,
      noticeShown: new Date().toISOString().slice(0, 10),
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

/** The most rule ids an event lists. */
const MAX_RULES = 100;

/** What an audit found, in numbers and rule ids: the rules are the tool's own. */
export interface RunReport {
  pages: number;
  counts: SeverityCounts;
  rules: string[];
}

const ids = (list: { rule: string }[] | undefined): string[] =>
  (list ?? []).map((item) => item.rule);

export const runReport = (report: Audit | AeoAudit): RunReport => {
  let rules: string[];
  let pages: number;

  switch (report.kind) {
    case "page": {
      rules = ids(report.findings);
      pages = 1;
      break;
    }

    case "site": {
      rules = [...ids(report.siteFindings), ...ids(report.issues)];
      pages = report.pages.length;
      break;
    }

    default: {
      rules = [...ids(report.findings), ...ids(report.issues)];
      pages = report.pages?.length ?? 1;
    }
  }

  return {
    pages,
    counts: report.counts,
    rules: [...new Set(rules)].toSorted().slice(0, MAX_RULES),
  };
};

/** One run of a CLI command, as its event tells it. */
export interface CliRun {
  command: string;
  /** The names of the flags the user gave, such as `--crawl`; never their values. */
  flags: readonly string[];
  startedAt: Date;
  started: number;
  target?: TargetKind;
  report?: RunReport;
}

export const startCliRun = (
  command: string,
  flags: readonly string[]
): CliRun => ({
  command,
  flags,
  startedAt: new Date(),
  started: performance.now(),
});

/** A run's `cli_command` event. Its id is new each time: no two runs can be linked. */
export const cliEvent = (run: CliRun, exitCode: number): PostHogEvent => ({
  event: "cli_command",
  timestamp: run.startedAt.toISOString(),
  properties: {
    ...BASE_PROPERTIES,
    distinct_id: uuidv7(),
    surface: "cli",
    command: run.command,
    flags: run.flags,
    target: run.target,
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

export const sendCliRun = (run: CliRun, exitCode: number): Promise<boolean> =>
  sendEvents([cliEvent(run, exitCode)], { timeoutMs: CLI_SEND_TIMEOUT_MS });

/** A session of the local MCP server ends after this long without a call, as PostHog's docs say. */
const IDLE_MS = 30 * 60_000;

/**
 * The local MCP server's analytics. A stdio connection is one client, so its calls share a
 * session, until a call comes after half an hour without one: a long-running server serves many
 * chats. `send` is for the tests.
 */
export const localMcpAnalytics = (
  send: (event: PostHogEvent) => void = (event) => {
    // The server keeps running: the event is sent alongside the next call, never in its way.
    void sendEvents([event], { timeoutMs: 5000 });
  }
): McpAnalytics => {
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

  return {
    initialize: (caller) => send(initializeEvent(caller, context())),
    toolCall: (call) => send(toolCallEvent(call, context())),
  };
};
