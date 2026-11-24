/**
 * The website's paths whose address holds a secret or a result (a share link's result, a shared
 * report's id, a waitlist link's secret, issue #232), and the name an error's route and an analytics
 * event give each in its place. worker.ts and the pages' script (analytics-script.ts) both read it,
 * so a new kind of secret link is one line here.
 */
export const SECRET_PATHS = [
  ["/share/", "/share/:result"],
  ["/report/", "/report/:id"],
  ["/premium/confirm/", "/premium/confirm/:token"],
  ["/premium/remove/", "/premium/remove/:token"],
] as const;

/** The name of `path` when it holds a secret, or null. */
export const secretPathName = (path: string): string | null =>
  SECRET_PATHS.find(([prefix]) => path.startsWith(prefix))?.[1] ?? null;
