# ToolGuard Tasks

## Status

**Parked as an open-source reference implementation (2026-04-21).** No active
development, no hosted demo, no launch planned. The repo stands as a working
reference for anyone building agent permissions infrastructure.

Decision context: the lane is well-served by funded competitors
(Microsoft `agent-governance-toolkit`, IBM `mcp-context-forge`, Obot, Lunar
MCPX). Reaching adoption from a solo TS-only repo would require sustained
distribution effort that isn't a priority right now. Parking now preserves
optionality without committing to a multi-week launch push.

## Shipped

- MVP scaffolding: TypeScript, Fastify, Prisma, Redis, BullMQ, Vitest, Docker.
- Storage layer: Prisma (Postgres) runtime + memory-backed adapter for tests,
  contract tests proving parity between the two.
- API surface: org bootstrap, API keys, agents, sessions, tools, policies,
  policy versions, policy evaluation, authorization, approvals, usage,
  audit, runs, replay.
- Policy engine, usage checks, approval lifecycle with atomic CAS on resolve,
  audit logging.
- Webhook notifications with HMAC signing and DNS-rebinding-aware URL
  validation at registration and delivery.
- Approval dashboard (`dashboard/`) with pending/resolved tabs and activity
  feed.
- SDK packages: `@toolguard/client`, `@toolguard/openai`, `@toolguard/mcp-proxy`.
- GitHub Actions CI: typecheck, unit tests, SDK build, store contract tests
  against Postgres, seed, live acceptance, final build.
- Docker Compose stack (`api` + `worker` + Postgres + Redis) and live
  acceptance script.
- Render Blueprint (`render.yaml`) and deploy walkthrough
  (`docs/DEPLOY_RENDER.md`) — included as a starting point for self-hosting,
  not deployed by the maintainer.

## Deferred (revisit only if reactivated)

If active development resumes, these are the highest-leverage items based
on the April 2026 market read:

- **Re-pitch positioning** from "permissions API" to "human-in-the-loop API
  + audit trail for AI agents" — the lane the funded competitors aren't
  focused on.
- **Python SDK + LangChain `BaseCallbackHandler` adapter** — Python is
  where most agent dev happens; current SDKs are TS-only.
- **`SECURITY.md`** with explicit threat model: catalog tampering, approval
  manipulation, webhook callback abuse, and the webhook HMAC contract.
- **Close residual DNS-rebinding window** in `WebhookService.sendWebhook`
  (validate, resolve, compare, fetch — or switch to a DNS-locked socket).
- **`CONTRIBUTING.md`** with dev setup, test matrix, PR expectations.
- **Per-webhook rate limits** and configurable delivery timeout (currently
  hard-coded to 10s in `src/services/webhook-service.ts`).
- **Audit `UsageCounter` upsert path** for true atomicity under concurrent
  increment; add a regression test if a race is reachable.
- **Dashboard UX polish**: loading states during approve/reject, clearer
  error surfacing.
- **Public demo deploy** via the included Render Blueprint, then Show HN
  with the live URL.
