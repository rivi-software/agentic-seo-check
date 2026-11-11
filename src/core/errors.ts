/**
 * A failure the tool expects and explains: the caller's input, a site's refusal, a browser or
 * Lighthouse that is not installed, a crawl robots.txt forbids. Its message is the answer, so error
 * tracking (issue #60) leaves it out: it is no bug of the tool's.
 */
export class ExpectedError extends Error {
  override name = "ExpectedError";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until the listener reads it
type CaughtErrorListener = (error: unknown) => void;

let listener: CaughtErrorListener | undefined;

/**
 * Hears the errors the core catches and turns into a finding, such as a crash in `--render`'s own
 * code: the user gets their answer, and the error may be a bug of the tool's. Only cli.ts and
 * mcp-bin.ts set one (issue #60); the library and the hosted server never do.
 */
export const onCaughtError = (next: CaughtErrorListener | undefined): void => {
  listener = next;
};

/** Tells the listener of `error`; it never throws into the audit that caught it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this reads it
export const caughtError = (error: unknown): void => {
  try {
    listener?.(error);
  } catch {
    // Error tracking never costs the user the answer.
  }
};
