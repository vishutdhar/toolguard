# Deploy ToolGuard to Render

This is the reference deployment for the public demo instance. The same
`render.yaml` Blueprint works for any fresh Render account.

## What gets provisioned

| Resource            | Type           | Purpose                              |
|---------------------|----------------|--------------------------------------|
| `toolguard-db`      | Postgres       | Primary data store (Prisma)          |
| `toolguard-redis`   | Redis/KeyValue | BullMQ queue for approval expiry     |
| `toolguard-api`     | Web (Docker)   | Fastify API, public HTTPS URL        |
| `toolguard-worker`  | Worker (Docker)| BullMQ worker, no public URL         |

Both services build from the existing `Dockerfile`. The API health check
targets `/healthz`. Postgres migrations run on every deploy via
`npx prisma migrate deploy` (already in the Dockerfile `CMD`).

## One-click blueprint deploy

1. Push `render.yaml` to the `master` branch.
2. Open https://dashboard.render.com/blueprints and click **New Blueprint
   Instance**.
3. Point it at `github.com/vishutdhar/toolguard`. Render reads
   `render.yaml` and shows the four resources above.
4. Name the Blueprint instance (e.g. `toolguard-demo`) and click **Apply**.
5. Wait for Postgres + Redis to go **Available**, then the API and worker
   services will build and deploy automatically.

Expected first-build time: ~5 min (Docker image + `npm ci` + Prisma generate
+ `tsc`).

## Verify the deploy

Once the API shows **Live**, grab its public URL (e.g.
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

The `/healthz` response should show `database: "ok"` and `redis: "ok"`. If
either is `down`, check the service logs in the Render dashboard — usually
the Postgres or Redis connection string hasn't propagated yet.

## Plan sizing notes

The Blueprint defaults are sized for a public demo, not production traffic:

- **Postgres `basic-256mb`** — smallest paid tier (~$6/mo). Free Postgres
  on Render expires after 30 days; do not use it for a persistent demo.
- **Redis `free`** — 25 MB, fine for approval expiry queue only.
- **Web/worker `starter`** — each ~$7/mo. Free web tier cold-starts after
  15 min of inactivity, which breaks the demo experience; starter keeps it
  always-on.

Resize in the Render dashboard before taking real load. Render plan names
change periodically; if `render.yaml` is rejected, check the [Render plans
docs](https://render.com/docs/plans) for current values and update in place.

## Public-demo hardening (before sharing the URL)

The Blueprint leaves `ENABLE_SWAGGER=true` and `ALLOW_SELF_SIGNUP=true` so
strangers can explore the API. Before you post the URL anywhere public:

1. **Rate limits.** The Fastify rate-limit plugin is already wired
   (`PUBLIC_RATE_LIMIT_MAX`, `PUBLIC_RATE_LIMIT_WINDOW_SECONDS`). Consider
   tightening both for a public demo (e.g. `60` / `60`).
2. **Daily caps.** `ORG_DAILY_MAX_ACTIONS` / `ORG_DAILY_MAX_SPEND_USD`
   prevent one org from draining demo resources. Lower to demo-sized values
   (e.g. 100 actions, $50) via the Render dashboard env tab.
3. **Webhook egress.** Webhook DNS validation only blocks private IPs at
   registration time. If strangers can register webhooks on the demo, they
   can use it as a callback probe. Either disable webhook registration via
   an ops flag or rotate the demo DB periodically.
4. **Swagger.** Flip `ENABLE_SWAGGER=false` once the README has a stable
   curl quickstart — Swagger UI on a public demo invites accidental writes.

These are not blockers for the first deploy — deploy first, harden, then
link from the README.

## Wire the demo URL into the README

Once live, open `README.md` and replace the `https://toolguard-api.example`
placeholder in the "Try the hosted demo" section with the real Render URL.
Commit and push; `autoDeploy: true` in the Blueprint redeploys the API
with the updated docs image.

## Tearing down

To avoid surprise bills, delete the Blueprint instance from the Render
dashboard (Blueprints → toolguard-demo → **Delete Blueprint**). This
removes all four resources atomically.
