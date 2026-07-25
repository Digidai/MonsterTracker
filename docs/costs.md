# Cost Model

## Formula

```text
probes_per_day = sum(monitor.daily_budget)
probes_per_month = probes_per_day * 30
active_minutes = min(1440, probes_per_day)
queue_messages_per_day = active_minutes
                       * ceil(probes_per_day / active_minutes / queue_batch_size)
queue_ops_per_day = queue_messages_per_day * 3
conservative_worker_invocations = probes_per_day
                                + 1440 cron invocations
                                + queue_messages_per_day queue consumers
```

The `* 3` queue estimate covers produce, consume, and delete operations.

## Example: 10 URLs / 10,000 Total Probes Per Day

Assume each URL has `daily_budget = 1000`.

```text
10 monitors * 1000 probes/day = 10,000 probes/day
10,000 probes/day * 30 = 300,000 probes/month
1,440 active minutes * ceil((10,000 / 1,440) / 5) * 3 = 8,640 queue ops/day
10,000 + 1,440 + 2,880 = 14,320 conservative Worker invocations/day
10,000 * 3 = 30,000 D1 writes/day before index overhead
```

Expected bill: `$0/month` on Free for this workload with the default 5-result Queue batch, but Queue operations have limited headroom. The estimate reflects the fact that messages are flushed independently by minute rather than pooled across the day. The conservative Worker estimate assumes every probe is a separate placed Worker invocation; regional batching can make actual invocations lower. Incident, usage, scheduler, retention, and index maintenance add D1 work beyond the three primary result statements.

## Upgrade Thresholds

Use Workers Paid when:

- You need more than 100 Workers in an account.
- You need more than 5 Cron triggers.
- A scheduler tick needs to call more than 50 regional probe Workers.
- Worst-case Worker requests approach 100,000/day.
- You want operational headroom for dashboard/API usage.
- You enable large extended/max region packs.

Workers Paid is currently `$5/month` plus usage above included limits. Verify current pricing before publishing exact numbers.
