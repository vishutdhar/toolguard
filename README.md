# ToolGuard

**Authorize AI tool calls before they execute.**

> **Status:** Open-source reference implementation. Not actively maintained;
> no hosted demo. The architecture, code, and docs are intended as a working
> reference for anyone building agent permissions infrastructure. Forks and
> adopters welcome.

ToolGuard is an open-source permissions API that sits between your AI agents and the tools they call. Define policies, enforce human approvals, track every action.

## What's worth copying

Even if you don't run ToolGuard end-to-end, several patterns inside it are
uncommon in public OSS and worth lifting into your own agent infrastructure.

- **Atomic compare-and-swap on approval resolution**
  ([`src/infrastructure/prisma/store.ts:415-440`](src/infrastructure/prisma/store.ts))
  — `updateApprovalRequest` accepts an `expectedStatus` and uses Prisma's
  `updateMany` with a `where: { id, status: expectedStatus }` clause, throwing
  a `409 APPROVAL_STATUS_CHANGED` if the row moved out from under you. This
  closes the TOCTOU race that most agent-approval systems quietly have when
  two reviewers click "approve" simultaneously. Concurrent regression test in
  [`test/integration/store-contract.test.ts`](test/integration/store-contract.test.ts).

- **DNS-rebind-aware webhook URL validation**
  ([`src/services/webhook-service.ts:90-118`](src/services/webhook-service.ts))
  — `validateWebhookUrl` blocks reserved hostnames *and* resolves the
  hostname and rejects any IP in private/reserved ranges. Re-validates at
  delivery time ([`webhook-service.ts:142-143`](src/services/webhook-service.ts))
  to defend against rebinding between registration and fetch. (Caveat: there's
  still a small validate→fetch window — see `TASKS.md` "Deferred" for the
  socket-pinning close.)

- **Server-authoritative tool catalog**
  ([`src/services/authorization-service.ts:73-108`](src/services/authorization-service.ts))
  — `tool.action`, `tool.resource`, `tool.riskLevel`, and `estimatedCostUsd`
  are loaded from the server-side catalog and never trusted from the caller.
  This is the difference between a permission system and a suggestion box;
  if the agent's HTTP client could declare "this is low-risk", policies are
  meaningless.

- **Decision precedence + environment-conditional defaults**
  ([`src/services/policy-service.ts:7-8`](src/services/policy-service.ts))
  — Decisions are ordered `deny > require_approval > allow`, and when no
  rule matches, the fallback is environment-aware: `DEV_DEFAULT_DECISION`
  defaults to `allow`, `PROD_DEFAULT_DECISION` defaults to `require_approval`.
  Closes the "forgot to write a prod policy → agent runs free" failure mode.

- **Storage adapter parity via contract tests**
  ([`test/integration/store-contract.test.ts`](test/integration/store-contract.test.ts))
  — The same test suite runs against both the Prisma store and the in-memory
  store. Useful pattern any time you want a fast in-process test backend
  without it drifting from production behavior.

- **HMAC-signed webhook contract**
  ([`src/services/webhook-service.ts:145-150`](src/services/webhook-service.ts))
  — `X-ToolGuard-Signature` is a SHA-256 HMAC over the raw request body using
  the per-webhook secret. Standard pattern, but worth copying because it's
  the minimum bar for a webhook receiver to trust the payload — and a lot of
  agent projects skip it.

If you only want one of these, the atomic CAS pattern and the
server-authoritative catalog are the two that fail silently most often in
hand-rolled implementations.

```
Agent calls stripe.refund($1,500)
  → ToolGuard evaluates policy → DENIED (threshold exceeded)

Agent calls gmail.send_email(external)
  → ToolGuard evaluates policy → APPROVAL REQUIRED → human approves → ALLOWED

Agent calls slack.post_message(internal)
  → ToolGuard evaluates policy → ALLOWED
```

[![CI](https://github.com/vishutdhar/toolguard/actions/workflows/ci.yml/badge.svg)](https://github.com/vishutdhar/toolguard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Why

AI agents are getting access to real tools — email, payments, databases, shell. Without a permissions layer:

- An agent can send emails to anyone, refund any amount, delete any record
- There's no audit trail of what happened or why
- There's no way to require human approval for high-risk actions
- Policy changes require code deploys instead of config updates

ToolGuard adds one API call before every tool execution. Your agent code barely changes — your policies do.

## Features

- **Policy engine** — declarative JSON rules matching on tool name, environment, risk level, payload fields
- **Human-in-the-loop approvals** — high-risk actions pause until a human approves or rejects
- **Audit log + replay** — every decision, approval, and tool execution is recorded and replayable
- **Usage limits** — daily caps on actions, spend, and tokens per org or per tool
- **Scoped sessions** — agents operate within declared permission scopes
- **Environment enforcement** — production policies can't be bypassed by spoofing environments
- **Server-side cost tracking** — estimated costs stored in the tool catalog, not trusted from callers
- **Atomic approval resolution** — concurrent approvals can't double-resolve

## Self-hosting

There is no hosted demo. Run locally via the [Quick Start](#quick-start)
below, or deploy your own instance. A Render Blueprint
([`render.yaml`](render.yaml), [`docs/DEPLOY_RENDER.md`](docs/DEPLOY_RENDER.md))
is included as a starting point.

## Quick Start

```bash
git clone https://github.com/vishutdhar/toolguard.git
cd toolguard
npm install
```

### Try it without Docker (in-memory mode)

```bash
npm run demo
```

This seeds 5 tools, 5 policies, and runs a full authorization flow — Slack allowed, Gmail requires approval, Stripe refund denied.

### Run the server

```bash
# In-memory (no dependencies)
STORAGE_MODE=memory npm run dev

# With Postgres + Redis
cp .env.example .env
docker compose up
```

### Bootstrap an organization

```bash
curl -s -X POST http://localhost:3000/v1/organizations \
  -H 'Content-Type: application/json' \
  -d '{"name": "My Org", "apiKeyName": "Default"}' | jq .
```

Save `rawApiKey` and `organization.id` from the response.

### Authorize a tool call

```bash
curl -s -X POST http://localhost:3000/v1/tool/authorize \
  -H "Authorization: Bearer $TG_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "orgId": "'$TG_ORG'",
    "agentId": "'$TG_AGENT'",
    "sessionId": "'$TG_SESSION'",
    "tool": {"name": "slack.post_message"},
    "context": {"justification": "Internal update"},
    "payloadSummary": {"channelType": "internal"}
  }' | jq .
```

```json
{
  "decision": "allow",
  "reasonCodes": ["INTERNAL_COLLABORATION"],
  "limits": { "remainingActionsToday": 999, "remainingBudgetUsd": 5000 }
}
```

Swagger docs at `http://localhost:3000/docs` when `ENABLE_SWAGGER=true`.

## SDK Packages

### `@toolguard/client` — TypeScript Client

```typescript
import { ToolGuard } from '@toolguard/client';

const tg = new ToolGuard({
  apiKey: process.env.TOOLGUARD_API_KEY,
  baseUrl: 'http://localhost:3000',
  orgId: 'org_...',
  agentId: 'agt_...',
});

const session = await tg.createSession({ scopes: ['email:send'] });
const result = await tg.authorize({
  sessionId: session.id,
  tool: { name: 'gmail.send_email' },
});

if (result.allowed) { /* execute */ }
else if (result.pendingApproval) { /* wait for human */ }
else { /* denied */ }
```

### `@toolguard/openai` — OpenAI Agent Loop

Wraps the OpenAI chat completions loop — every tool call is authorized automatically:

```typescript
import { runAgent } from '@toolguard/openai';

const result = await runAgent({
  openai: openaiClient,
  toolguard: tg,
  messages: [{ role: 'user', content: 'Handle ticket #4821' }],
  openaiTools: tools,
  tools: guardedTools,
  sessionId: session.id,
});
// result.message — final assistant response
// result.iterations — number of LLM round-trips
```

### `@toolguard/mcp-proxy` — MCP Gateway

Drop-in proxy for any MCP server. Authorizes every `tools/call` before forwarding to the upstream server:

```bash
export TOOLGUARD_API_KEY="tg_..."
toolguard-mcp --config gateway.json -- npx @modelcontextprotocol/server-filesystem /tmp
```

No changes to your MCP client or server — ToolGuard sits in between. See [`examples/mcp-gateway-config.json`](examples/mcp-gateway-config.json).

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  AI Agent    │────▶│  ToolGuard   │────▶│  Tool / API     │
│  (OpenAI,   │     │  API Server  │     │  (Slack, Gmail,  │
│   MCP, etc) │◀────│              │◀────│   Stripe, etc)   │
└─────────────┘     └──────┬───────┘     └─────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼───┐  ┌────▼────┐  ┌───▼────┐
        │ Policy  │  │Approval │  │ Audit  │
        │ Engine  │  │  Queue  │  │  Log   │
        └─────────┘  └─────────┘  └────────┘
```

- **Server:** Fastify, TypeScript, Zod validation
- **Storage:** Postgres (Prisma) or in-memory for dev/test
- **Queue:** Redis + BullMQ for approval expiry
- **Auth:** Org-scoped API keys (`Authorization: Bearer tg_...`)

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/organizations` | Bootstrap org + first API key |
| `POST` | `/v1/agents` | Register an agent |
| `POST` | `/v1/sessions` | Start a scoped session |
| `POST` | `/v1/tools` | Register a tool in the catalog |
| `POST` | `/v1/policies` | Create a policy |
| `POST` | `/v1/policies/:id/versions` | Add a policy version |
| **`POST`** | **`/v1/tool/authorize`** | **Authorize a tool call** |
| `POST` | `/v1/policy/evaluate` | Dry-run policy evaluation |
| `POST` | `/v1/approvals/request` | Request human approval |
| `POST` | `/v1/approvals/:id/resolve` | Approve or reject |
| `POST` | `/v1/usage/check` | Check usage limits |
| `POST` | `/v1/runs` | Start a run |
| `POST` | `/v1/runs/:id/complete` | Complete a run |
| `GET`  | `/v1/runs/:id/replay` | Replay a run's audit timeline |

## Policy Rules

Policies are declarative JSON rules. The `if` block matches against tool metadata, environment, and payload fields. The `then` block specifies the decision.

```json
{
  "if": {
    "tool.name": "stripe.refund",
    "environment": "production",
    "payloadSummary.amountUsd": { "gt": 1000 }
  },
  "then": {
    "decision": "deny",
    "reasonCodes": ["REFUND_THRESHOLD_EXCEEDED"]
  }
}
```

Decision precedence: `deny` > `require_approval` > `allow`. When no rule matches, the server falls back to `DEV_DEFAULT_DECISION` or `PROD_DEFAULT_DECISION`.

## Default Authorization Behavior

- Development defaults to `allow` when no rule matches
- Production defaults to `require_approval` when no rule matches
- Tool `action`, `resource`, and `riskLevel` are loaded from the server-side catalog — callers cannot override them
- Session environment is authoritative and must match the agent's configured environment

## Development

```bash
npm install
npm run dev              # hot-reload server (in-memory)
npm test                 # 32 core + 46 package tests
npm run typecheck        # type check server + packages
npm run build            # build server
npm run build:packages   # build all SDK packages
```

### Testing with Postgres

```bash
docker compose up -d postgres
TEST_DATABASE_URL="postgresql://toolguard:toolguard@localhost:5432/toolguard_test" npm test
```

### Full stack validation

```bash
cp .env.example .env
docker compose up --build -d
npm run seed
npm run acceptance:live
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_MODE` | `prisma` | `prisma` or `memory` |
| `DATABASE_URL` | — | Postgres connection string |
| `REDIS_URL` | — | Redis connection string |
| `ENABLE_SWAGGER` | `true` | Swagger UI at `/docs` |
| `DEV_DEFAULT_DECISION` | `allow` | Default when no rule matches (non-prod) |
| `PROD_DEFAULT_DECISION` | `require_approval` | Default when no rule matches (prod) |
| `APPROVAL_TTL_MINUTES` | `60` | Approval expiration window |
| `ORG_DAILY_MAX_ACTIONS` | `1000` | Org daily action limit |
| `ORG_DAILY_MAX_SPEND_USD` | `500` | Org daily spend limit |
| `PER_TOOL_DAILY_MAX_ACTIONS` | `200` | Per-tool daily action limit |

See [`.env.example`](.env.example) for the full list.

## Contributing

Contributions welcome. Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
