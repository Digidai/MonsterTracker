export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const concurrency = Math.max(1, Math.min(items.length, Math.floor(limit) || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await mapper(item, index);
    }
  });

  await Promise.all(workers);
  return results;
}
