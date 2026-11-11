/**
 * Error tracking (issue #60): one `$exception` event per unexpected error, in the shape PostHog's
 * error tracking reads (`$exception_list`, as @posthog/core builds it: the error first, then each
 * cause, and each stack's oldest call first). It keeps #57's promise of no URL, hostname, path or
 * text from a page: a message loses its URLs, paths, quoted text, hostnames and addresses, and a
 * frame keeps its file's place in the package, never the directories above it, which hold the
 * user's home and often their name. It runs in Node and in a Worker.
 */
import { ExpectedError } from "../core/errors.js";
import { BASE_PROPERTIES } from "./posthog.js";
import type { PostHogEvent, PropertyValue } from "./posthog.js";

/** One call of a stack, as PostHog reads a raw frame. */
export interface ExceptionFrame {
  platform: "node:javascript";
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  /** The package's own code, not a dependency's or Node's. */
  in_app: boolean;
}

/** One error of `$exception_list`: the error that was thrown first, then its causes. */
export interface ExceptionEntry {
  type: string;
  value: string;
  mechanism: {
    type: "generic" | "chained";
    /** Set on the first entry: false when only a last resort caught the error. */
    handled?: boolean;
    synthetic: false;
    exception_id: number;
    parent_id?: number;
    source?: "cause";
  };
  stacktrace?: { type: "raw"; frames: ExceptionFrame[] };
}

/** How much of a message is read, and how much of what is left is sent. */
const MAX_READ = 2000;
const MAX_MESSAGE = 300;

/** The most errors of a `cause` chain an event lists, and the most frames of each. */
const MAX_ERRORS = 5;
const MAX_FRAMES = 50;

/** A name in code, such as the property in "Cannot read properties of undefined (reading 'href')". */
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/u;

/**
 * A message without what could be a user's or a page's: our own messages name the audited target,
 * and V8's JSON.parse quotes its input, which can be a page. Every pattern reads a bounded stretch
 * from each place it starts, so a long message cannot make it backtrack.
 */
export const cleanMessage = (message: string): string => {
  const text = message
    .slice(0, MAX_READ)
    // A URL, whose host and path are the audited site's, up to a space or a quote.
    .replaceAll(/\b[a-z][\d+.a-z-]{0,31}:\/\/[^\s"'`<>]*/giu, "<url>")
    // A file's path, absolute or relative, on any system.
    .replaceAll(
      /(?<![^\s(=,:[])(?:~|\.{1,2}|[a-z]:)?[/\\][^\s"'`]+/giu,
      "<path>"
    )
    // Quoted text, up to its closing quote or the end. A single-quoted name is code, and stays.
    .replaceAll(/"[^"]*"?|`[^`]*`?|“[^”]*”?/gu, "<text>")
    .replaceAll(/'(?<inner>[^']*)'/gu, (quoted, inner: string) =>
      IDENTIFIER.test(inner) ? quoted : "<text>"
    )
    .replaceAll(/[\w.+-]{1,64}@[^\s@]{1,255}/gu, "<email>")
    .replaceAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu, "<ip>")
    // Anything that reads as a hostname. It takes `a.map` in "a.map is not a function" too: the
    // frame says where that was.
    .replaceAll(
      /\b(?:[\da-z](?:[\da-z-]{0,61}[\da-z])?\.)+[a-z]{2,63}\b/giu,
      "<host>"
    );

  return text.length > MAX_MESSAGE
    ? `${text.slice(0, MAX_MESSAGE - 1)}…`
    : text;
};

/** Where npm and pnpm put the package, inside a node_modules directory. */
export const PACKAGE_PATH = "@rivi-software/agentic-seo-check/";

const NODE_MODULES = "node_modules/";

/** A path with forward slashes, and without the slash a file URL puts before a drive letter. */
const slashes = (path: string): string => {
  const forward = path.replaceAll("\\", "/");

  return /^\/[a-z]:\//iu.test(forward) ? forward.slice(1) : forward;
};

/**
 * The package's directory, from this module's place in it (src/telemetry/ or dist/telemetry/),
 * with a slash at the end. A Worker's bundle has none.
 */
const packageRoot = (): string | undefined => {
  try {
    const url = new URL("../../", import.meta.url);

    if (url.protocol !== "file:") {
      return undefined;
    }

    const root = slashes(decodeURIComponent(url.pathname));

    return root.length > 1 ? root : undefined;
  } catch {
    return undefined;
  }
};

/** A file of a frame, as an event may name it: its place in the package or in node_modules. */
const placeOf = (
  file: string,
  root: string | undefined
): Pick<ExceptionFrame, "filename" | "in_app"> => {
  let name = file;

  if (name.startsWith("file://")) {
    try {
      name = decodeURIComponent(name.slice("file://".length));
    } catch {
      name = name.slice("file://".length);
    }
  }

  name = slashes(name);

  if (name.startsWith("node:")) {
    return { filename: name, in_app: false };
  }

  const modules = name.lastIndexOf(`/${NODE_MODULES}`);

  if (modules !== -1 || name.startsWith(NODE_MODULES)) {
    const inside = name.slice(
      modules === -1 ? NODE_MODULES.length : modules + NODE_MODULES.length + 1
    );

    return inside.startsWith(PACKAGE_PATH)
      ? { filename: inside.slice(PACKAGE_PATH.length), in_app: true }
      : { filename: `${NODE_MODULES}${inside}`, in_app: false };
  }

  if (root && name.startsWith(root)) {
    return { filename: name.slice(root.length), in_app: true };
  }

  // Any other file's directories can hold the user's name: its own name only.
  if (name.startsWith("/") || /^[a-z]:\//iu.test(name)) {
    return { filename: name.slice(name.lastIndexOf("/") + 1), in_app: false };
  }

  // A Worker's bundle (`index.js`) is a JavaScript or TypeScript file by a relative name. Nothing
  // else is, such as a hostname or a URL that text from a page made look like a frame.
  // Its folders, if any, have no dot, so a hostname cannot pass for one.
  if (/^(?:[\w-]+\/)*[\w.-]+\.[cm]?[jt]s$/u.test(name)) {
    return { filename: name, in_app: true };
  }

  // V8's own: `native`, `<anonymous>`.
  return {
    filename: name === "native" || /^<\w+>$/u.test(name) ? name : "<unknown>",
    in_app: false,
  };
};

/**
 * A function's name as V8 writes one (`run`, `new Promise`, `Object.<anonymous>`,
 * `fn [as alias]`), or `?` for anything else, such as words or a URL.
 */
const functionName = (name: string): string =>
  /^(?:new )?[\w$.<>]{1,200}(?: \[as [\w$.<>]{1,50}\])?$/u.test(name)
    ? name
    : "?";

/** One line of a V8 stack, such as `    at async run (file:///…/dist/cli.js:12:5)`. */
const parseFrame = (
  line: string,
  root: string | undefined
): ExceptionFrame | undefined => {
  const text = line.trim();

  if (!text.startsWith("at ") || text.length > 1024) {
    return undefined;
  }

  let rest = text.slice("at ".length);

  if (rest.startsWith("async ")) {
    rest = rest.slice("async ".length);
  }

  let name = "";
  let where = rest;
  const open = rest.indexOf(" (");

  if (open > 0 && rest.endsWith(")")) {
    name = rest.slice(0, open);
    where = rest.slice(open + 2, -1);
  }

  const frame = {
    platform: "node:javascript" as const,
    function: functionName(name),
  };

  // Code made by eval: `eval at f (file:1:2), <anonymous>:3:4`.
  if (where.startsWith("eval at ")) {
    return { ...frame, filename: "<eval>", in_app: false };
  }

  const colon = where.lastIndexOf(":");
  const before = colon > 0 ? where.lastIndexOf(":", colon - 1) : -1;
  const lineno = Number(where.slice(before + 1, colon));
  const colno = Number(where.slice(colon + 1));

  if (before > 0 && Number.isInteger(lineno) && Number.isInteger(colno)) {
    return {
      ...frame,
      ...placeOf(where.slice(0, before), root),
      lineno,
      colno,
    };
  }

  return { ...frame, ...placeOf(where, root) };
};

/** The frames of `error`'s stack, the oldest call first, as PostHog orders them. */
const framesOf = (
  error: Error,
  root: string | undefined
): ExceptionFrame[] | undefined => {
  // A library may set `stack` to anything; String() reads what V8 wrote.
  const written = String(error.stack ?? "");

  // The stack starts with the message, which may hold anything: frames come after it. V8 writes the
  // stack when it is first read, so a message changed after that no longer matches: then as many
  // lines as the message has are skipped, and a frame's names must still read as code.
  const message = String(error.message);
  const header = `${String(error.name)}: ${message}`;

  const stack = written.startsWith(header)
    ? written.slice(header.length)
    : written.split("\n").slice(message.split("\n").length).join("\n");

  const frames: ExceptionFrame[] = [];

  for (const line of stack.split("\n")) {
    const frame = parseFrame(line, root);

    if (frame) {
      frames.push(frame);
    }

    if (frames.length === MAX_FRAMES) {
      break;
    }
  }

  return frames.length > 0 ? frames.toReversed() : undefined;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this reads it
const typeOf = (error: unknown): string =>
  error instanceof Error && error.name
    ? String(error.name).slice(0, 64)
    : "Error";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- as above
const messageOf = (error: unknown): string =>
  cleanMessage(error instanceof Error ? String(error.message) : String(error));

/** `error` and its causes, as `$exception_list` lists them. */
export const exceptionList = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- as above
  error: unknown,
  handled: boolean
): ExceptionEntry[] => {
  const root = packageRoot();
  const list: ExceptionEntry[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (
    current !== undefined &&
    current !== null &&
    list.length < MAX_ERRORS &&
    !seen.has(current)
  ) {
    seen.add(current);

    const id = list.length;

    const frames =
      current instanceof Error ? framesOf(current, root) : undefined;

    list.push({
      type: typeOf(current),
      value: messageOf(current),
      mechanism:
        id === 0
          ? { type: "generic", handled, synthetic: false, exception_id: 0 }
          : {
              type: "chained",
              source: "cause",
              synthetic: false,
              exception_id: id,
              parent_id: id - 1,
            },
      ...(frames ? { stacktrace: { type: "raw" as const, frames } } : null),
    });

    current = current instanceof Error ? current.cause : undefined;
  }

  return list;
};

/** Errors no bug throws: a timeout or an abort is the network's, or the user's. */
const EXPECTED_NAMES = new Set(["AbortError", "TimeoutError"]);

/** Whether `error` may be a bug, and so worth an event. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- as above
export const reportable = (error: unknown): boolean =>
  !(error instanceof ExpectedError) &&
  !(error instanceof Error && EXPECTED_NAMES.has(error.name));

/** Where an error happened, as its event says it. */
export interface ExceptionContext {
  /** The run's or the session's id: the one its `cli_command` or `$mcp_tool_call` has. */
  distinctId: string;
  sessionId?: string;
  /** False when only a last resort caught it: the CLI's, the Worker's 500, an uncaught error. */
  handled: boolean;
  surface: "cli" | "local" | "hosted";
  properties?: Record<string, PropertyValue | undefined>;
}

/** The `$exception` event of `error`, or undefined when it is no bug (`reportable`). */
export const exceptionEvent = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- as above
  error: unknown,
  context: ExceptionContext,
  at = new Date()
): PostHogEvent | undefined => {
  if (!reportable(error)) {
    return undefined;
  }

  let list: ExceptionEntry[];

  try {
    list = exceptionList(error, context.handled);
  } catch {
    // A thrown value String() cannot read, such as an object without a prototype: no event, and
    // never an error in the error's way.
    return undefined;
  }

  return {
    event: "$exception",
    timestamp: at.toISOString(),
    properties: {
      ...BASE_PROPERTIES,
      distinct_id: context.distinctId,
      $session_id: context.sessionId,
      surface: context.surface,
      $exception_list: list,
      $exception_level: "error",
      ...context.properties,
    },
  };
};
