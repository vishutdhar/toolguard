# ToolGuard Tasks

## Status

Active. ToolGuard is positioned as human approval plus an audit log for AI
agents, before they take real actions like sending email, refunding a
charge, or posting to Slack. Development resumed in October 2026.

## Shipped

- MVP scaffolding: TypeScript, Fastify, Prisma, Redis, BullMQ, Vitest, Docker.
- Storage layer: Prisma (Postgres) runtime and a memory-backed adapter for
  tests, with contract tests proving parity between the two.
- API surface: org bootstrap, API keys, agents, sessions, tools, policies,
  policy versions, policy evaluation, authorization, approvals, usage,
  audit, runs, replay, webhooks.
- Policy engine, usage checks, approval lifecycle with atomic CAS on resolve,
  audit logging.
- Webhook notifications with HMAC signing and URL validation at registration
  and delivery. Delivery pins the connection to the validated IP.
- Approval dashboard (`dashboard/`) with pending and resolved tabs and an
  activity feed.
- SDK packages: `@toolguard/client`, `@toolguard/openai`, `@toolguard/mcp-proxy`.
- Python SDK (`packages/python`) with sync and async clients, a webhook
  signature helper, and a LangChain callback handler.
- Security audit fixes (PR #1): environment fail-safe defaults, API key
  scopes with `approvals:resolve` and `api_keys:create`, no scope escalation
  when minting keys, approval expiry and replay fixes, stable cursor
  pagination, and a non-root container.
- GitHub Actions CI: typecheck, unit tests, SDK build, store contract tests
  against Postgres, seed, live acceptance, final build, and a Python SDK job.
- Docker Compose stack (`api`, `worker`, Postgres, Redis) and live
  acceptance script.
- Render Blueprints: `render.yaml` (free, in memory) and `render.prisma.yaml`
  (Postgres, Redis, worker), with a walkthrough in `docs/DEPLOY_RENDER.md`.

## Deferred

- [x] Re-pitch positioning from "permissions API" to "human-in-the-loop API
  + audit trail for AI agents".
- [x] Python SDK + LangChain `BaseCallbackHandler` adapter.
- [ ] `SECURITY.md` with an explicit threat model: catalog tampering, approval
  manipulation, webhook callback abuse, and the webhook HMAC contract.
- [x] Close the residual DNS-rebinding window in webhook delivery. Fixed in
  PR #1: delivery pins the connection to the validated IP.
- [ ] `CONTRIBUTING.md` with dev setup, test matrix, PR expectations.
- [ ] Per-webhook rate limits and a configurable delivery timeout (currently
  hard-coded to 10s in `src/services/webhook-service.ts`).
- [ ] Audit the `UsageCounter` upsert path for true atomicity under concurrent
  increment; add a regression test if a race is reachable.
- [ ] Dashboard UX polish: loading states during approve and reject, clearer
  error surfacing.
- [ ] Public demo deploy via the free Render Blueprint.
- [ ] TypeScript client parity with the Python SDK: `invocationId` on
  `authorize()`, `scopes` on `createApiKey()`, list and webhook methods.
