# MonsterTracker

Cloudflare-native website monitoring built on Workers, D1, Queues, R2, Analytics Engine, and Workers Placement Hints.

MonsterTracker deliberately does **not** use Cloudflare Health Checks. It runs your own probe Workers and distributes a daily probe budget across placed regions.

## What It Can And Cannot Promise

MonsterTracker can:

- Run HTTP/HTTPS checks from many Cloudflare Workers with `placement.region` hints.
- Rotate a daily probe budget across regions, for example `10 URLs / 10,000 probes per day`.
- Record Cloudflare edge metadata such as colo, country, ASN, and `cf-placement`.
- Stay inside Cloudflare Free quotas for small and medium self-hosted deployments.

MonsterTracker cannot:

- Guarantee a specific Cloudflare PoP or city for every probe.
- Reproduce residential ISP, mobile carrier, or mainland China network behavior.
- Reliably monitor third-party sites at high frequency without their permission.

Cloudflare Placement Hints place a Worker near a named cloud region while still running on Cloudflare infrastructure. See [Workers Placement](https://developers.cloudflare.com/workers/configuration/placement/). Worker subrequests are not billed separately; the core platform costs are Worker invocations, storage, queues, and analytics. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Architecture

```text
Control Worker
  - dashboard and API
  - cron scheduler
  - budget distribution
  - D1 config/latest/incidents
  - Queue producer

Placed Probe Workers
  - same source code, ROLE=probe
  - one Worker per placement.region
  - POST /internal/probe
  - returns probe results to the control Worker

Collector
  - Queue consumer in control Worker
  - writes D1 latest/raw results
  - writes Analytics Engine data points
  - archives raw batches to R2
```

The active scheduler uses this deterministic formula:

```text
minute quota = floor((minute + 1) * daily_budget / 1440)
             - floor(minute * daily_budget / 1440)
```

This guarantees each monitor gets exactly its configured daily budget over a UTC day.

## Cost Example

For `10 URLs / 10,000 total probes per day`:

| Item | Daily Use | Free Quota Fit |
|---|---:|---|
| Worker requests, worst case | 10,000 | yes, Free has 100,000/day |
| Worker outbound fetches | 10,000 | not billed as separate subrequests |
| Analytics Engine points | 10,000 | yes, Free has 100,000/day |
| D1 writes | about 30,000/day before index overhead | yes, Free has 100,000 writes/day |
| Queue operations | 600/day with 50-result batches | yes, Free has 10,000 ops/day |
| R2 archive | MB-level | yes, Free includes 10 GB-month |

MonsterTracker writes about three D1 rows/statements per probe in the default raw-results mode: raw result, latest result, and region calibration. For 10,000 probes/day, budget around 30,000 D1 writes/day before index overhead and incident updates.

Expected Cloudflare bill: **$0/month** if you batch Queue messages and stay within Free Worker count/cron/D1 limits.

Free-tier deployments should keep the core region pack unless they understand the subrequest limit. The control Worker makes one outbound request per active probe Worker in a scheduler invocation. Core uses 24 regions; extended uses more than 50 and is meant for Workers Paid or future sharded dispatch.

The committed control Worker config includes `global_fetch_strictly_public`. Cloudflare otherwise returns error `1042` when one Worker fetches another Worker on the same workers.dev zone. Service Bindings are the cleaner long-term option, but URL dispatch keeps the open-source deployment generator simple and lets regions be changed from D1.

Use the built-in estimator:

```bash
curl "http://localhost:8787/api/cost?urls=10&probesPerDay=10000&queueBatchSize=50"
```

## Local Development

```bash
npm install
npm run types
npm run db:migrate:local
npx wrangler dev --test-scheduled --port 8787 \
  --var ADMIN_TOKEN:dev-admin-token \
  --var SHARED_SECRET:dev-shared-secret \
  --var ALLOW_LOCAL_PROBES:true
```

Open `http://localhost:8787`.

For write actions in local development, add `.dev.vars`:

```text
ADMIN_TOKEN=dev-admin-token
SHARED_SECRET=dev-shared-secret
PUBLIC_BASE_URL=http://localhost:8787
```

Then create a monitor in the dashboard and click `Run Due Now`.

## Cloudflare Deployment

Create resources:

```bash
wrangler d1 create monstertracker
wrangler r2 bucket create monstertracker-archive
wrangler queues create monstertracker-results
```

Update `wrangler.jsonc` with the real D1 `database_id`.

Set secrets:

```bash
wrangler secret put ADMIN_TOKEN
wrangler secret put SHARED_SECRET
```

Apply schema and deploy:

```bash
npm run db:migrate:remote
npm run deploy
```

For production, keep `ALLOW_LOCAL_PROBES=false`. Regional probes must be reached through `regions.worker_url` or `PROBE_URL_TEMPLATE`.

## Regional Probe Workers

Generate probe Worker configs:

```bash
npm run generate:probes
```

Core pack currently creates 24 placed probe Workers. Extended pack:

```bash
node scripts/generate-probe-configs.mjs --extended
```

Deploy generated probes:

```bash
bash generated/probes/deploy-all.sh
```

Set the same `SHARED_SECRET` on each probe Worker:

```bash
wrangler secret put SHARED_SECRET --config generated/probes/use1.wrangler.jsonc
```

After deployment, update `regions.worker_url` in D1. The generator writes a helper file:

```bash
sed 's/WORKERS_SUBDOMAIN/YOUR_SUBDOMAIN/g' generated/probes/set-worker-urls.sql > /tmp/monstertracker-set-worker-urls.sql
wrangler d1 execute monstertracker --remote --file /tmp/monstertracker-set-worker-urls.sql
```

Do not run the generated file before replacing the placeholder.

Alternatively, set a template on the control Worker:

```jsonc
"PROBE_URL_TEMPLATE": "https://monstertracker-probe-{id}.YOUR_SUBDOMAIN.workers.dev"
```

## Configuration

Important variables:

| Variable | Purpose |
|---|---|
| `ADMIN_TOKEN` | Bearer token for dashboard write actions |
| `SHARED_SECRET` | Secret for control-to-probe calls |
| `REGION_PACK` | `core` or `extended` default seed regions |
| `DEFAULT_DAILY_PROBE_BUDGET` | Default per-monitor daily probes |
| `PROBE_BATCH_SIZE` | Results per Queue message |
| `PROBE_URL_TEMPLATE` | Optional template like `https://monstertracker-probe-{id}.example.workers.dev` |
| `PUBLIC_BASE_URL` | Control Worker URL used by cron in local/single-worker mode |
| `ALLOW_LOCAL_PROBES` | Allows `/internal/probe` on localhost without secret |
| `MAX_DAILY_PROBES` | Account-level scheduler cap across monitors |
| `MAX_MONITOR_DAILY_BUDGET` | Per-monitor daily budget ceiling |
| `ALLOW_PRIVATE_TARGETS` | Allows local/private/IP-literal targets when set to `true` |

## edgetunnel Research Notes

[cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) is a different class of project, but its Worker product mechanics are useful:

- Single-file Worker/Pages deployment reduces adoption friction.
- Environment variables such as `ADMIN`, `DEBUG`, and `OFF_LOG` make self-hosting practical.
- KV-backed first-run configuration is a good UX pattern; MonsterTracker uses D1 bootstrap instead.
- `ctx.waitUntil()` keeps logging and persistence off the request path.
- Recording `request.cf` fields is essential for edge observability.
- A built-in Cloudflare usage panel is worth adding; MonsterTracker already stores daily usage counters.

MonsterTracker does not reuse edgetunnel proxy/tunnel protocol logic.
