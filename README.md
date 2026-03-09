# ToolGuard

ToolGuard is an Agent Permissions API for AI tool-calling workflows. Before an agent can send email, post messages, issue refunds, execute commands, or export sensitive data, ToolGuard evaluates policy, usage limits, and approval status, then records the outcome for audit and replay.

## What the MVP includes

- Agent and session identity
- Tool policy evaluation with `allow`, `deny`, and `require_approval`
- Usage checks for daily actions, spend, per-tool actions, and token budgets
- Human approval requests with resolution and expiration support
- Structured audit logging
- Run replay from stored audit events
- Basic org, API key, agent, tool, and policy management
- OpenAPI docs via Swagger UI
- Example support-agent flow for Slack, Gmail, and Stripe

## Architecture

- Backend: Fastify + TypeScript
- Database: PostgreSQL via Prisma
- Counters and queue: Redis + BullMQ
- Validation: Zod
- Tests: Vitest
- Runtime modes:
  - `prisma`: normal app mode with PostgreSQL and Redis
  - `memory`: deterministic mode for tests and demo script

## Default authorization behavior

- Development defaults to `allow` when no rule matches.
- Production defaults to `require_approval` when no rule matches.
- Explicit `deny` always wins over `require_approval`, which wins over `allow`.
- Tool `action`, `resource`, and `riskLevel` are loaded from ToolGuard's stored tool catalog. Clients may send them for debugging, but mismatches are rejected.
- The session environment is authoritative. Requests cannot downgrade a production session to development by overriding `context.environment`.

## Local setup

1. Create a local env file from the example:

```bash
cp .env.example .env
```

2. Start the stack:

```bash
npm run compose:up
```

3. Seed demo data:

```bash
npm run seed
```

4. Run the live acceptance flow:

```bash
npm run acceptance:live
```

5. Open API docs:

```text
http://localhost:3000/docs
```

In `prisma` mode, both the API and worker fail fast during startup if PostgreSQL or Redis is unreachable. That is intentional; ToolGuard should not accept traffic with dead dependencies underneath it.

## Non-Docker development

The automated tests and demo run in `memory` mode and do not require PostgreSQL or Redis.

```bash
npm install
npm test
npm run demo
```

The live acceptance flow is for the real Docker-backed stack and bootstraps its own organization, tools, policies, session, run, approvals, and replay assertions through the public API:

```bash
npm run acceptance:live
```

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `NODE_ENV` | Runtime mode | `development` |
| `HOST` | Fastify listen host | `0.0.0.0` |
| `PORT` | Fastify listen port | `3000` |
| `LOG_LEVEL` | Pino log level | `info` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://toolguard:toolguard@localhost:5432/toolguard?schema=public` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `STORAGE_MODE` | `prisma` or `memory` | `prisma` |
| `ENABLE_SWAGGER` | Enable Swagger UI | `true` |
| `ALLOW_SELF_SIGNUP` | Allow unauthenticated org bootstrap | `true` |
| `DEV_DEFAULT_DECISION` | Default decision outside production | `allow` |
| `PROD_DEFAULT_DECISION` | Default decision in production | `require_approval` |
| `APPROVAL_TTL_MINUTES` | Approval expiration window | `60` |
| `PUBLIC_RATE_LIMIT_MAX` | Public rate limit burst | `120` |
| `PUBLIC_RATE_LIMIT_WINDOW_SECONDS` | Public rate-limit window | `60` |
| `ORG_DAILY_MAX_ACTIONS` | Org daily action limit | `1000` |
| `ORG_DAILY_MAX_SPEND_USD` | Org daily spend limit | `500` |
| `ORG_DAILY_MAX_TOKENS` | Org daily token limit | `200000` |
| `PER_TOOL_DAILY_MAX_ACTIONS` | Per-tool daily action limit | `200` |
| `BULLMQ_ENABLED` | Enable approval expiry queue | `true` |

## Auth

ToolGuard uses org-scoped API keys in the `Authorization` header:

```text
Authorization: Bearer tg_...
```

Use `POST /v1/organizations` to bootstrap a new organization and receive the first raw API key.

## Demo flow

The example in [support-agent-demo.ts](/Users/vishutdhar/Code/toolguard/examples/support-agent-demo.ts) simulates:

1. Creating a session
2. Starting a run
3. Allowing an internal Slack post
4. Requiring approval for external Gmail in production
5. Approving the Gmail action and retrying authorization
6. Denying a high-value Stripe refund
7. Completing the run and replaying the timeline

Run it with:

```bash
npm run demo
```

## Live acceptance

The live acceptance script in [live-acceptance.ts](/Users/vishutdhar/Code/toolguard/scripts/live-acceptance.ts) is the repeatable end-to-end validation path for the real Postgres + Redis stack. It waits for `/healthz`, bootstraps a fresh organization, creates the support agent, registers tools and policies, runs the Slack/Gmail/Stripe authorization flow, resolves the Gmail approval, completes the run, and verifies the exact replay timeline.

Use it after the Docker stack is up:

```bash
npm run acceptance:live
```

Override the base URL if needed:

```bash
TOOLGUARD_BASE_URL=http://127.0.0.1:3000 npm run acceptance:live
```

## CI

The GitHub Actions workflow in [.github/workflows/ci.yml](/Users/vishutdhar/Code/toolguard/.github/workflows/ci.yml) validates both modes:

- `npm run typecheck`
- `npm test`
- `docker compose up --build -d`
- `npm run seed`
- `npm run acceptance:live`
- `npm run build`

## Key endpoints

- `POST /v1/organizations`
- `POST /v1/api-keys`
- `POST /v1/agents`
- `POST /v1/sessions`
- `POST /v1/tools`
- `GET /v1/tools`
- `POST /v1/policies`
- `GET /v1/policies/:policyId`
- `POST /v1/policies/:policyId/versions`
- `POST /v1/policy/evaluate`
- `POST /v1/usage/check`
- `POST /v1/tool/authorize`
- `POST /v1/approvals/request`
- `GET /v1/approvals/:approvalId`
- `POST /v1/approvals/:approvalId/resolve`
- `POST /v1/audit/events`
- `POST /v1/runs`
- `POST /v1/runs/:runId/complete`
- `GET /v1/runs/:runId/replay`

## Curl examples

Bootstrap an organization:

```bash
curl -X POST http://localhost:3000/v1/organizations \
  -H 'content-type: application/json' \
  -d '{
    "name": "Acme Support",
    "apiKeyName": "Default key"
  }'
```

Create an agent:

```bash
curl -X POST http://localhost:3000/v1/agents \
  -H "Authorization: Bearer $TOOLGUARD_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "orgId": "org_123",
    "name": "support-agent",
    "environment": "production",
    "defaultScopes": ["slack:write", "gmail:send", "stripe:refund"]
  }'
```

Create a session:

```bash
curl -X POST http://localhost:3000/v1/sessions \
  -H "Authorization: Bearer $TOOLGUARD_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "orgId": "org_123",
    "agentId": "agent_123",
    "userId": "user_789",
    "servicePrincipal": null,
    "environment": "production",
    "scopes": ["gmail:send", "slack:write"],
    "metadata": {
      "source": "support-bot"
    }
  }'
```

Authorize an internal Slack post:

```bash
curl -X POST http://localhost:3000/v1/tool/authorize \
  -H "Authorization: Bearer $TOOLGUARD_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "orgId": "org_123",
    "agentId": "agent_123",
    "sessionId": "sess_123",
    "tool": {
      "name": "slack.post_message",
      "action": "post",
      "resource": "internal_channel",
      "riskLevel": "low",
      "estimatedCostUsd": 0
    },
    "context": {
      "environment": "production",
      "justification": "Internal case update"
    },
    "payloadSummary": {
      "channelType": "internal"
    },
    "tokenCount": 25
  }'
```

Authorize an external Gmail send in production:

```bash
curl -X POST http://localhost:3000/v1/tool/authorize \
  -H "Authorization: Bearer $TOOLGUARD_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "orgId": "org_123",
    "agentId": "agent_123",
    "sessionId": "sess_123",
    "tool": {
      "name": "gmail.send_email",
      "action": "send",
      "resource": "external_email",
      "riskLevel": "high",
      "estimatedCostUsd": 0
    },
    "context": {
      "environment": "production",
      "justification": "Send refund update to customer",
      "sensitivity": "customer_data"
    },
    "payloadSummary": {
      "recipientDomain": "gmail.com",
      "containsAttachment": false
    },
    "tokenCount": 120
  }'
```

Resolve an approval:

```bash
curl -X POST http://localhost:3000/v1/approvals/approval_123/resolve \
  -H "Authorization: Bearer $TOOLGUARD_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "status": "approved"
  }'
```

Replay a run:

```bash
curl http://localhost:3000/v1/runs/run_123/replay \
  -H "Authorization: Bearer $TOOLGUARD_API_KEY"
```

## Notes and limitations

- The MVP uses a simple JSON rule model, not a full policy DSL.
- `POST /v1/tool/authorize` enforces session scopes using provider/action scopes such as `slack:write`, `gmail:send`, and `stripe:refund`, with support for provider wildcards like `slack:*`.
- `POST /v1/approvals/:approvalId/resolve` records the reviewer as the authenticated API key prefix, not a caller-supplied `resolvedBy` value.
- Approval expiry is enforced both lazily during approval reads and via the optional BullMQ worker.
- `.env.example` uses `localhost` so host-side commands like `npm run seed` work directly. `docker compose` overrides service hosts to `postgres` and `redis` inside containers.
- Use `npm run compose:up` and `npm run compose:down`, which wrap `docker compose`, instead of the legacy `docker-compose` binary.
- The optional dashboard is not implemented.
- Docker services are defined, but this environment did not have Docker available to execute `docker compose` during development, so the API was validated through build, tests, and the in-memory demo path.
