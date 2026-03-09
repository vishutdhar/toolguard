# ToolGuard MVP Tasks

## Completed
- Project workspace scaffolded under `toolguard`
- TypeScript, Fastify, Prisma, Redis, BullMQ, and Vitest dependencies installed
- Dockerfile and `docker-compose.yml` added for Postgres + Redis local runtime, with `docker compose` wrapper scripts
- Prisma schema, generated migration, and seed script added
- Fastify app bootstrap with health, auth, OpenAPI docs, CORS, rate limiting, and structured errors
- Storage adapters for Prisma runtime and memory-backed tests
- Organization bootstrap, API key, agent, session, tool, policy, usage, approval, audit, run, and replay endpoints
- Policy engine, usage checks, authorization flow, approval lifecycle, and audit logging
- Demo seed data, support-agent example flow, and BullMQ worker entrypoint
- Unit and integration tests for policy matching, usage limits, sessions, authorization, approvals, and replay
- Repeatable live acceptance script for the Docker-backed API
- GitHub Actions CI workflow covering typecheck, tests, seed, live acceptance, and production build

## In Progress
- None

## Remaining
- Optional dashboard UI
