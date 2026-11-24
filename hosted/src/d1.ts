/**
 * The part of D1's API the Workers call, which D1Database has, so a test can fake it over SQLite.
 */

export interface D1Statement {
  bind: (...values: unknown[]) => D1Statement;
  run: () => Promise<{ success: boolean }>;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
}

export interface D1Like {
  prepare: (sql: string) => D1Statement;
}
