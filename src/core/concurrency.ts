/** Minimal promise pool: at most `concurrency` tasks run at once, the rest wait in order. */
export const createPool = (concurrency: number) => {
  let active = 0;
  const queue: (() => void)[] = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < Math.max(1, concurrency)) {
      active += 1;
    } else {
      // A finishing task hands its slot straight to the next in line, so `active` never drops
      // and a newcomer cannot slip in ahead of the queue.
      // oxlint-disable-next-line promise/avoid-new -- the wait ends on a callback another task calls, which only a new Promise can await
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }

    try {
      return await task();
    } finally {
      const nextInLine = queue.shift();

      if (nextInLine) {
        nextInLine();
      } else {
        active -= 1;
      }
    }
  };
};

export const mapConcurrent = <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const run = createPool(concurrency);

  return Promise.all(items.map((item, i) => run(() => fn(item, i))));
};

/**
 * Resolves after `ms`, on the global `setTimeout`, so a test's fake timers reach it: they patch
 * `node:timers/promises` as an object, which a named import from it never sees.
 */
export const sleep = async (ms: number): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- the wait ends on a timer's callback, which only a new Promise can await
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};
