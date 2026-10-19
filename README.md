# ToolGuard

Human approval and an audit log for AI agents, before they take real actions.

ToolGuard is an open-source API that sits between your agent and its tools. Before the agent sends an email, refunds a Stripe charge, or posts to Slack, it asks ToolGuard. Your policies decide whether the call is allowed, denied, or held for a person to approve, and every decision goes into an audit log you can replay.

[![CI](https://github.com/vishutdhar/toolguard/actions/workflows/ci.yml/badge.svg)](https://github.com/vishutdhar/toolguard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<!-- DEMO LINK: add the hosted demo URL here once it is live. -->

```
Agent calls stripe.refund($1,500)
  -> policy: refunds over $1,000 are denied -> DENIED

Agent calls gmail.send_email(external recipient)
  -> policy: external email needs approval -> PENDING -> a person approves -> ALLOWED

Agent calls slack.post_message(internal channel)
  -> policy: internal Slack is fine -> ALLOWED
```

## Why

Agents now get real credentials for email, payments, databases, and shells. Without a layer in between:

- An agent can email anyone, refund any amount, or delete any record.
- Nobody can say afterward what the agent did or why.
- There is no way to make a person sign off on the risky calls.
- Changing what an agent may do means changing and redeploying its code.

With ToolGuard, the agent makes one API call before each tool runs. The rules live in ToolGuard, so you can change them without touching the agent.

## Features

- Risky calls pause until a person approves or rejects them, and each approval can be used once.
- Every decision, approval, and run event goes into an audit log, and you can replay any run.
- Policies are JSON rules that match on tool name, environment, risk level, and payload fields.
- API keys carry scopes, so the agent's key can request approvals but cannot grant them.
- Daily caps limit actions, spend, and tokens per org and per tool.
- Each session declares which tools the agent may use.
- A tool's action, resource, risk level, and cost come from the server's catalog, never from the caller.
- Webhook deliveries are signed with HMAC-SHA256.
- There are SDKs for Python, with a LangChain handler, and TypeScript, with an OpenAI agent loop and an MCP gateway.

## Quick Start

Requires Node.js 22.19 or newer.

```bash
git clone https://github.com/vishutdhar/toolguard.git
cd toolguard
npm install
```

### Try it without Docker

```bash
npm run demo
```

This seeds 5 tools and 5 policies in memory and runs a full flow: the Slack post is allowed, the Gmail send needs approval, and the Stripe refund is denied.

### Run the server

```bash
# In memory, no dependencies
STORAGE_MODE=memory npm run dev

# With Postgres and Redis
cp .env.example .env
docker compose up
```

### Create an organization

```bash
curl -s -X POST http://localhost:3000/v1/organizations \
  -H 'Content-Type: application/json' \
  -d '{"name": "My Org", "apiKeyName": "Default"}' | jq .
```

Save `rawApiKey` and `organization.id` from the response. This first key has full access.

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

Swagger docs are at `http://localhost:3000/docs` when `ENABLE_SWAGGER=true`.

## Python SDK

[`packages/python`](packages/python) has a sync and an async client, a webhook signature helper, and a LangChain callback handler. It is not on PyPI yet, so install it from the repo:

```bash
pip install "toolguard[langchain] @ git+https://github.com/vishutdhar/toolguard#subdirectory=packages/python"
```

```python
from toolguard import ToolGuard

tg = ToolGuard(api_key=AGENT_KEY, base_url="http://localhost:3000", org_id=ORG_ID, agent_id=AGENT_ID)

decision = tg.authorize(session_id, {"name": "stripe.refund"}, payload_summary={"amountUsd": 40})

if decision.allowed:
    ...  # run the refund
elif decision.pending_approval:
    # Block until a person resolves it, then authorize again with the approval id.
    decision = tg.wait_for_approval(
        decision.approval_id, session_id, {"name": "stripe.refund"}, payload_summary={"amountUsd": 40}
    )
else:
    print("denied:", decision.reason_codes)
```

### LangChain

`ToolGuardCallbackHandler` authorizes every tool call in `on_tool_start`. A denied call raises `ToolCallDenied` and a call that needs approval raises `ApprovalRequired`, so the tool never runs.

```python
from toolguard.langchain import ToolGuardCallbackHandler, ToolMapping

handler = ToolGuardCallbackHandler(
    tg,
    session_id,
    tool_map={
        "issue_refund": ToolMapping(
            name="stripe.refund",
            payload_summary=lambda args: {"amountUsd": args["amount_usd"]},
        ),
    },
)

agent.invoke({"input": "Refund order 4821"}, config={"callbacks": [handler]})
```

Pass `wait_for_approval=True` to make the handler wait for a person instead of raising. See the [Python SDK README](packages/python/README.md) for async usage, webhooks, and the full method list.

## TypeScript SDKs

### `@toolguard/client`

```typescript
import { ToolGuard } from '@toolguard/client';

const tg = new ToolGuard({
  apiKey: process.env.TOOLGUARD_API_KEY,
  baseUrl: 'http://localhost:3000',
  orgId: 'org_...',
  agentId: 'agt_...',
});

const session = await tg.createSession({ scopes: ['gmail:send'] });
const result = await tg.authorize({
  sessionId: session.id,
  tool: { name: 'gmail.send_email' },
});

if (result.allowed) { /* execute */ }
else if (result.pendingApproval) { /* wait for a person */ }
else { /* denied */ }
```

### `@toolguard/openai`

Wraps the OpenAI chat completions loop and authorizes every tool call:

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
// result.message: final assistant response
// result.iterations: number of LLM round trips
```

### `@toolguard/mcp-proxy`

A proxy for any MCP server. It authorizes every `tools/call` before forwarding it upstream:

```bash
export TOOLGUARD_API_KEY="tg_..."
toolguard-mcp --config gateway.json -- npx @modelcontextprotocol/server-filesystem /tmp
```

Your MCP client and server stay unchanged. See [`examples/mcp-gateway-config.json`](examples/mcp-gateway-config.json).

## API keys and approvals

A key's `scopes` decide what it can do. `["*"]` is full access.

- Resolving an approval needs `approvals:resolve`. Give the agent a key with `["tool:authorize"]` and it can ask for approvals but cannot approve its own requests.
- Creating a key needs `api_keys:create`, and the new key's scopes must be a subset of the caller's. A restricted key that asks for more gets `403 SCOPE_ESCALATION`.
- After approval, the agent calls `/v1/tool/authorize` again with the `approvalId` and an `invocationId`. The approval is consumed once, and a retry with the same `invocationId` gets the same answer.

The approval dashboard in [`dashboard/`](dashboard) shows pending and resolved approvals and lets a person approve or reject them. Resolving needs a key with `approvals:resolve`.

## Deploy

Two Render Blueprints are included:

- [`render.yaml`](render.yaml): one free web service with in-memory storage. Good for trying it out. Data is lost when the service restarts.
- [`render.prisma.yaml`](render.prisma.yaml): Postgres, Redis, the API, and the worker on paid plans.

[`docs/DEPLOY_RENDER.md`](docs/DEPLOY_RENDER.md) walks through both. The Docker Compose stack in [`docker-compose.yml`](docker-compose.yml) runs the same services anywhere.

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

- Server: Fastify, TypeScript, Zod validation
- Storage: Postgres (Prisma), or in memory for dev, tests, and the free demo
- Queue: Redis and BullMQ for approval expiry
- Auth: org-scoped API keys (`Authorization: Bearer tg_...`) with scopes

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Health and storage mode |
| `POST` | `/v1/organizations` | Create an org and its first API key |
| `POST` | `/v1/api-keys` | Create an API key with scopes |
| `POST`, `GET` | `/v1/agents` | Register or list agents |
| `POST` | `/v1/sessions` | Start a scoped session |
| `POST`, `GET` | `/v1/tools` | Register or list catalog tools |
| `POST` | `/v1/policies` | Create a policy |
| `GET` | `/v1/policies/:id` | Get a policy and its versions |
| `POST` | `/v1/policies/:id/versions` | Add a policy version |
| `POST` | `/v1/tool/authorize` | Authorize a tool call |
| `POST` | `/v1/policy/evaluate` | Dry-run policy evaluation |
| `POST` | `/v1/usage/check` | Check usage limits |
| `POST` | `/v1/approvals/request` | Request an approval by hand |
| `GET` | `/v1/approvals` | List approvals (cursor pagination) |
| `GET` | `/v1/approvals/:id` | Get an approval |
| `POST` | `/v1/approvals/:id/resolve` | Approve or reject |
| `POST`, `GET` | `/v1/audit/events` | Write or list audit events (cursor pagination) |
| `POST` | `/v1/runs` | Start a run |
| `POST` | `/v1/runs/:id/complete` | Complete a run |
| `GET` | `/v1/runs/:id/replay` | Replay a run's audit timeline |
| `POST`, `GET` | `/v1/webhooks` | Register or list webhooks |
| `DELETE` | `/v1/webhooks/:id` | Delete a webhook |

Errors use one shape: `{"error": "CODE", "message": "...", "details": {...}}`.

## Policy Rules

Policies are JSON rules. The `if` block matches tool metadata, environment, and payload fields. The `then` block gives the decision.

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

Decision precedence is `deny`, then `require_approval`, then `allow`. When no rule matches, the server falls back to `DEV_DEFAULT_DECISION` or `PROD_DEFAULT_DECISION`.

## Default Authorization Behavior

- Development defaults to `allow` when no rule matches.
- Production, and any environment label that is not a known dev environment, defaults to `require_approval`.
- Tool `action`, `resource`, and `riskLevel` come from the server-side catalog. Callers cannot override them.
- The session environment must match the agent's configured environment.

## Design notes

Some parts of the code handle cases that hand-rolled approval systems often miss.

Approval resolution is atomic. `updateApprovalRequest` in [`src/infrastructure/prisma/store.ts`](src/infrastructure/prisma/store.ts) takes an `expectedStatus` and updates with `where: { id, status: expectedStatus }`, so if two reviewers click at once, the second gets `409 APPROVAL_STATUS_CHANGED`. A concurrency test is in [`test/integration/store-contract.test.ts`](test/integration/store-contract.test.ts).

Webhook delivery is protected against SSRF and DNS rebinding. [`src/services/webhook-service.ts`](src/services/webhook-service.ts) blocks reserved hostnames, resolves the host, and rejects private or reserved IPs, both at registration and again at delivery. The delivery connection is pinned to the IP that was just validated, so the HTTP client cannot resolve the name a second time to a different address. A host with no DNS answer is refused.

The tool catalog is server-authoritative. In [`src/services/authorization-service.ts`](src/services/authorization-service.ts), `tool.action`, `tool.resource`, `tool.riskLevel`, and `estimatedCostUsd` come from the catalog. If the agent could declare its own call low risk, the policies would not mean much.

With no matching rule, production falls back to `require_approval`, so a missing prod policy does not let the agent run unchecked.

The same contract tests run against the Prisma store and the in-memory store, which keeps the fast test backend in line with production.

`X-ToolGuard-Signature` is the hex HMAC-SHA256 of the raw webhook body, keyed with the webhook secret. The Python SDK has `verify_webhook_signature()` for receivers.

## Development

```bash
npm install
npm run dev              # hot-reload server (in memory)
npm test                 # server tests
npm run typecheck        # type check the server
npm run build            # build the server
npm run build:packages   # build the TypeScript SDK packages
```

Python SDK:

```bash
cd packages/python
pip install -e ".[dev]"
pytest                   # integration tests need `npm run build` at the repo root
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
| `DATABASE_URL` | local Postgres | Postgres connection string |
| `REDIS_URL` | local Redis | Redis connection string |
| `ENABLE_SWAGGER` | `true` | Swagger UI at `/docs` |
| `ALLOW_SELF_SIGNUP` | `true` | Allow `POST /v1/organizations` without a key |
| `CORS_ALLOWED_ORIGINS` | empty | Comma-separated origins allowed from a browser, such as the dashboard |
| `DEV_DEFAULT_DECISION` | `allow` | Default when no rule matches (dev) |
| `PROD_DEFAULT_DECISION` | `require_approval` | Default when no rule matches (prod) |
| `APPROVAL_TTL_MINUTES` | `60` | Approval expiration window |
| `ORG_DAILY_MAX_ACTIONS` | `1000` | Org daily action limit |
| `ORG_DAILY_MAX_SPEND_USD` | `500` | Org daily spend limit |
| `PER_TOOL_DAILY_MAX_ACTIONS` | `200` | Per-tool daily action limit |

See [`.env.example`](.env.example) for the full list.

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
