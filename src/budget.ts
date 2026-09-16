export function applyGlobalDailyCap<T extends { dailyBudget: number; enabled?: boolean; id?: string }>(
  monitors: T[],
  maxDailyProbes: number
): T[] {
  const cap = Math.max(0, Math.floor(maxDailyProbes));
  const enabled = monitors
    .map((monitor, index) => ({ index, monitor, budget: Math.max(0, Math.floor(monitor.dailyBudget)) }))
    .filter((item) => item.monitor.enabled !== false && item.budget > 0);
  const totalBudget = enabled.reduce((total, item) => total + item.budget, 0);
  if (totalBudget <= cap) return monitors;

  const allocations = enabled.map((item) => {
    const exact = totalBudget > 0 ? (item.budget / totalBudget) * cap : 0;
    return {
      ...item,
      allocation: Math.min(item.budget, Math.floor(exact)),
      remainder: exact - Math.floor(exact)
    };
  });
  let remaining = cap - allocations.reduce((total, item) => total + item.allocation, 0);
  const remainderOrder = [...allocations].sort(
    (left, right) =>
      right.remainder - left.remainder ||
      (left.monitor.id ?? String(left.index)).localeCompare(right.monitor.id ?? String(right.index))
  );
  for (const item of remainderOrder) {
    if (remaining <= 0) break;
    if (item.allocation >= item.budget) continue;
    item.allocation += 1;
    remaining -= 1;
  }

  const byIndex = new Map(allocations.map((item) => [item.index, item.allocation]));
  return monitors.map((monitor, index) =>
    byIndex.has(index) ? { ...monitor, dailyBudget: byIndex.get(index) ?? 0 } : monitor
  );
}
