/**
 * A failure the tool expects and explains: the caller's input, a site's refusal, a browser or
 * Lighthouse that is not installed, a crawl robots.txt forbids. Its message is the answer, so error
 * tracking (issue #60) leaves it out: it is no bug of the tool's.
 */
export class ExpectedError extends Error {
  override name = "ExpectedError";
  /**
   * Why, from a fixed list of the tool's own names, such as `target` or `robots_txt`: the message
   * says it to a person, this to the MCP servers' analytics, which `fail` gives it to (issue #123).
   * Never a URL, an argument's value or a page's words.
   */
  readonly reason: string | undefined;

  constructor(
    message?: string,
    options: ErrorOptions & { reason?: string } = {}
  ) {
    const { reason, ...rest } = options;
    super(message, rest);
    this.reason = reason;
  }
}

/** What the core was doing when it caught an error, as far as the tool's own names say it. */
export interface CaughtErrorContext {
  /** The rule whose check threw (issue #85): an id of the tool's own, never anything of a page's. */
  rule?: string;
  /** What the tool was doing, from a fixed list of its own, such as `request_signature` (issue #93). */
  task?: string;
}

type CaughtErrorListener = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until the listener reads it
  error: unknown,
  context: CaughtErrorContext
) => void;

let listener: CaughtErrorListener | undefined;

/**
 * Hears the errors the core catches and turns into a finding, such as a crash in `--render`'s own
 * code, a rule that throws, or a page a crawl leaves out: the user gets their answer, and the error
 * may be a bug of the tool's. Only cli.ts, mcp-bin.ts and the hosted server's Worker set one
 * (issues #60, #85 and #93); the library never does.
 */
export const onCaughtError = (next: CaughtErrorListener | undefined): void => {
  listener = next;
};

/** Tells the listener of `error`; it never throws into the audit that caught it. */
export const caughtError = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this reads it
  error: unknown,
  context: CaughtErrorContext = {}
): void => {
  try {
    listener?.(error, context);
  } catch {
    // Error tracking never costs the user the answer.
  }
};
