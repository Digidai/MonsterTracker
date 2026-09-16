# Cost model

The estimator simulates all 1,440 UTC minutes for each monitor's effective budget. It sums each minute's results and rounds up messages at the configured batch size. The API assumes an even split; Usage uses actual budgets after the global cap.

For 10 monitors with 1,000 probes each per day:

```text
1,000 active minutes × 10 results = 10,000 probes/day
1,000 × ceil(10 / 10) = 1,000 messages/day
1,000 × 3 = 3,000 Queue operations/day (baseline)
10,000 + 1,440 Cron + 1,000 consumers = 12,440 Worker invocations/day (upper estimate)
```

The previous 5-result policy uses 6,000 operations for these budgets. The older 8,640 estimate ignored per-monitor minute alignment.

Queue billing uses 64 KB units including metadata. Normal delivery uses write/read/delete; retries and DLQ add operations. Manual samples consume the global probe cap and add messages. Examples assume every trigger runs and messages stay below 64 KB. [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)

D1 counters are logical primary row writes, not metered billing. Indexes, acknowledgements, usage markers, incidents, scheduling and retention add writes. `fitsD1FreeWrites` is null and the estimator recommends `verify-d1` when other modeled limits fit. Verify Cloudflare Metrics before promising a free deployment. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

The ten-result consumer executes 39 persistence statements plus one usage statement, including ten distinct monitors and incident creation. SQLite tests enforce this against the Free limit of 50 queries per invocation. Batching reduces round trips, not billable rows. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Static assets bypass the control script; only API, internal probe and health routes run it first. History loads on demand. Raw-row retention runs hourly with bounded deletes. Account quotas are shared with other applications.
