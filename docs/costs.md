# Cost Model

## Formula

```text
probes_per_day = sum(monitor.daily_budget)
probes_per_month = probes_per_day * 30
queue_ops_per_day = ceil(probes_per_day / queue_batch_size) * 3
```

The `* 3` queue estimate covers produce, consume, and delete operations.

## Example: 10 URLs / 10,000 Total Probes Per Day

Assume each URL has `daily_budget = 1000`.

```text
10 monitors * 1000 probes/day = 10,000 probes/day
10,000 probes/day * 30 = 300,000 probes/month
ceil(10,000 / 50) * 3 = 600 queue ops/day
10,000 * 3 = 30,000 D1 writes/day before index overhead
```

Expected bill: `$0/month` on Free when using batched Queue messages and default raw-result writes. Higher retention or extra indexes can increase D1 row reads/writes.

## Upgrade Thresholds

Use Workers Paid when:

- You need more than 100 Workers in an account.
- You need more than 5 Cron triggers.
- A scheduler tick needs to call more than 50 regional probe Workers.
- Worst-case Worker requests approach 100,000/day.
- You want operational headroom for dashboard/API usage.
- You enable large extended/max region packs.

Workers Paid is currently `$5/month` plus usage above included limits. Verify current pricing before publishing exact numbers.
