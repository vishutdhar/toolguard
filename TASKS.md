# ToolGuard Tasks

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

## Active - Public demo launch

- [ ] Deploy to Render via `render.yaml` Blueprint. Follow
      [`docs/DEPLOY_RENDER.md`](docs/DEPLOY_RENDER.md).
- [ ] Replace `https://toolguard-api.example` placeholder in `README.md`
      with the real Render URL after first successful deploy.
- [ ] Harden demo env before publishing the URL: tighten rate limits,
      lower daily caps, decide on webhook registration policy, consider
      `ENABLE_SWAGGER=false`.
- [ ] Smoke-test the README "Try the hosted demo" curl flow end to end
      against the live URL.

## Queued - Open-source readiness

- [ ] `SECURITY.md` with threat model: catalog tampering, approval
      manipulation, webhook callback abuse, and the webhook HMAC contract.
- [ ] Close residual DNS-rebinding window in `WebhookService.sendWebhook`
      (validate, resolve, compare, fetch — or switch to a DNS-locked
      socket). Current mitigation is registration-time + delivery-time
      validation with a gap between validate and `fetch`.
- [ ] `CONTRIBUTING.md` with dev setup, test matrix, and PR expectations.
- [ ] Per-webhook rate limits and configurable delivery timeout (currently
      hard-coded to 10s in `src/services/webhook-service.ts`).

## Queued - Correctness follow-ups

- [ ] Audit `UsageCounter` upsert path for true atomicity under concurrent
      increment; add a regression test if a race is reachable.
- [ ] Dashboard UX polish: loading states during approve/reject, clearer
      error surfacing.

## Backlog - Post-launch

- Adoption examples: LangChain integration sample, Claude Agent SDK sample
  alongside the existing OpenAI and MCP examples.
- Policy authoring ergonomics: policy linter, dry-run CLI.
- Multi-tenant hardening beyond the current org-scoped keys.
