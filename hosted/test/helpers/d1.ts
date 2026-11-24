import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { D1Like, D1Statement } from "../../src/d1.ts";

/** D1's prepare, bind, run, first and all, over SQLite. */
export const d1Of = (db: DatabaseSync): D1Like => ({
  prepare: (sql) => {
    let args: SQLInputValue[] = [];

    const statement: D1Statement = {
      bind: (...values) => {
        // SAFETY: the callers bind strings, numbers and null, which SQLite takes.
        args = values as SQLInputValue[];

        return statement;
      },
      run: () => {
        db.prepare(sql).run(...args);

        return Promise.resolve({ success: true });
      },
      first: <T>() =>
        // SAFETY: each query names the columns of the Row its caller asks for.
        Promise.resolve((db.prepare(sql).get(...args) ?? null) as T | null),
      all: <T>() =>
        Promise.resolve({
          // SAFETY: as in first.
          results: db.prepare(sql).all(...args) as T[],
        }),
    };

    return statement;
  },
});
