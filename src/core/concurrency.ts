/** Minimal promise pool. */
export function createPool(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        task().then(resolve, reject).finally(next);
      };
      if (active < Math.max(1, concurrency)) start();
      else queue.push(start);
    });
  };
}

export async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const run = createPool(concurrency);
  return Promise.all(items.map((item, i) => run(() => fn(item, i))));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
