# Deploy ToolGuard to Render

The repo has two Render Blueprints:

| File                 | What it creates                                    | Cost       |
|----------------------|----------------------------------------------------|------------|
| `render.yaml`        | One free web service with `STORAGE_MODE=memory`    | Free       |
| `render.prisma.yaml` | Postgres, Redis, API, and worker with Prisma storage | Paid plans |

Render uses `render.yaml` by default, so a new Blueprint gets the free demo
unless you pick the other file.

## Free demo (`render.yaml`)

This runs the API as a single Node web service on Render's free plan. There
is no database, Redis, or worker. All state (API keys, approvals, and the
audit log) lives in process memory.

The free plan idles the service after about 15 minutes without traffic, and
every restart or redeploy wipes the in-memory data. Keys stop working and the
audit trail is gone. That is fine for trying the API, but not for anything
you need to keep.

Deploy it:

1. Open https://dashboard.render.com/blueprints and click New Blueprint
   Instance.
2. Point it at `github.com/vishutdhar/toolguard`. Render reads `render.yaml`
   and shows one web service, `toolguard-api`.
3. When asked, set `CORS_ALLOWED_ORIGINS`. It is a comma-separated list of
   origins that may call the API from a browser, for example the URL where
   the dashboard is deployed. Leave it empty if no browser client needs
   access.
4. Click Apply.

Settings in this Blueprint: Swagger is off, self-signup is on, BullMQ is off,
and approvals expire after 60 minutes.

## Durable deploy (`render.prisma.yaml`)

This Blueprint provisions:

| Resource           | Type            | Purpose                           |
|--------------------|-----------------|-----------------------------------|
| `toolguard-db`     | Postgres        | Primary data store (Prisma)       |
| `toolguard-redis`  | Redis/KeyValue  | BullMQ queue for approval expiry  |
| `toolguard-api`    | Web (Docker)    | Fastify API, public HTTPS URL     |
| `toolguard-worker` | Worker (Docker) | BullMQ worker, no public URL      |

Both services build from the `Dockerfile`. The API health check targets
`/healthz`. Postgres migrations run on every deploy through
`npx prisma migrate deploy`.

Deploy it:

1. Open https://dashboard.render.com/blueprints and click New Blueprint
   Instance.
2. Point it at `github.com/vishutdhar/toolguard` and set the Blueprint file
   path to `render.prisma.yaml`.
3. Name the instance (for example `toolguard-demo`) and click Apply.
4. Wait for Postgres and Redis to show Available. The API and worker then
   build and deploy on their own.

The first build takes about 5 minutes (Docker image, `npm ci`, Prisma
generate, and `tsc`).

This Blueprint does not set `CORS_ALLOWED_ORIGINS`. Add it in the API's
environment tab if a browser client such as the dashboard will call the API.

### Plan sizing

The defaults suit a demo, not production traffic:

- Postgres `basic-256mb` is the smallest paid tier (about $6/mo). Free
  Postgres on Render expires after 30 days, so don't use it for a demo you
  want to keep.
- Redis `free` has 25 MB, which is enough for the approval expiry queue.
- The web and worker services use `starter`, about $7/mo each. The free web
  tier cold-starts after 15 minutes without traffic, and `starter` stays on.

Resize in the Render dashboard before taking real load. Render renames plans
from time to time. If the Blueprint is rejected, check the
[Render plans docs](https://render.com/docs/plans) and update the file.

## Verify the deploy

Once the API shows Live, take its public URL (for example
`https://toolguard-api.onrender.com`) and run:

```bash
export TG_URL=https://toolguard-api.onrender.com

# Health (includes DB + Redis status)
curl -s $TG_URL/healthz | jq .

# Bootstrap a demo org
curl -s -X POST $TG_URL/v1/organizations \
  -H 'Content-Type: application/json' \
  -d '{"name": "Demo", "apiKeyName": "Default"}' | jq .
```

On the free demo, `/healthz` reports `storageMode: "memory"` with the
database and Redis marked `skipped`. On the durable deploy it should show
`database: "ok"` and `redis: "ok"`. If either is `down`, check the service
logs in the Render dashboard. Usually the Postgres or Redis connection string
hasn't propagated yet.

## Before sharing a public URL

Both Blueprints leave `ALLOW_SELF_SIGNUP=true` so people can create an org
and try the API. `render.prisma.yaml` also turns on Swagger
(`ENABLE_SWAGGER=true`). Before you post a URL anywhere public:

1. Rate limits. The Fastify rate-limit plugin reads
   `PUBLIC_RATE_LIMIT_MAX` and `PUBLIC_RATE_LIMIT_WINDOW_SECONDS`. Consider
   tightening both for a public demo (for example `60` and `60`).
2. Daily caps. `ORG_DAILY_MAX_ACTIONS` and `ORG_DAILY_MAX_SPEND_USD` stop
   one org from using up demo resources. Lower them to demo sizes (for
   example 100 actions and $50) in the Render environment tab.
3. Webhook egress. Webhook DNS validation only blocks private IPs at
   registration time. If strangers can register webhooks on the demo, they
   can use it as a callback probe. Disable webhook registration with an ops
   flag or reset the demo data from time to time.
4. Swagger. On the durable deploy, set `ENABLE_SWAGGER=false` once the
   README has a stable curl quickstart, since Swagger UI on a public demo
   invites accidental writes.

None of these block a first deploy. Deploy, harden, then link the URL from
the README.

## Tearing down

Delete the Blueprint instance from the Render dashboard (Blueprints, then the
instance, then Delete Blueprint). This removes every resource it created, so
the paid Blueprint stops billing.
