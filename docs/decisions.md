# ToolGuard Decisions

## D-001: Single-service MVP
- Date: 2026-03-06
- Decision: Build ToolGuard as one Fastify service instead of a workspace monorepo.
- Why: The repo starts blank and the MVP is API-first. A single service keeps startup time, test setup, and deployment complexity down while still allowing clean module boundaries.

## D-002: Dual storage modes
- Date: 2026-03-06
- Decision: Support `prisma` for normal runtime and `memory` for tests/demo fallback.
- Why: The target stack is Postgres + Redis, but this environment does not currently have Docker available. A memory adapter keeps tests deterministic while the Prisma schema, migrations, and Docker setup remain the main local-dev path.

## D-003: Safe defaults
- Date: 2026-03-06
- Decision: Default unmatched policy decisions to `allow` in development and `require_approval` in production.
- Why: This matches the product intent of being permissive for local iteration and conservative in higher-risk environments without introducing a full organization settings model yet.

## D-004: Prisma 6.19 for MVP stability
- Date: 2026-03-06
- Decision: Pin Prisma and `@prisma/client` to `6.19.0`.
- Why: Prisma 7 requires an ESM + adapter + `prisma.config.ts` migration. For this MVP, Prisma 6 keeps the service CommonJS-compatible, reduces startup complexity, and preserves the boring local developer path.

## D-005: Server-authoritative authorization context
- Date: 2026-03-06
- Decision: Treat the stored Tool definition and Session environment as authoritative during policy evaluation and authorization.
- Why: Letting clients supply tool metadata or override environment creates direct bypasses for policy, scope, and approval checks. The API now resolves the canonical tool by name, rejects mismatches, enforces session-derived environment, and attributes approval resolution to the authenticated API key instead of caller-supplied reviewer IDs.

## D-006: Fail fast in Prisma mode
- Date: 2026-03-06
- Decision: In `prisma` mode, the API and worker perform dependency preflight before starting normal runtime work.
- Why: Starting the process while PostgreSQL or Redis is unavailable produces a misleading "healthy" service that cannot authorize tools correctly. Failing fast makes Docker, Compose, and production-style deployments safer and easier to debug.

## D-007: Live acceptance should bootstrap through the public API
- Date: 2026-03-06
- Decision: The repeatable end-to-end validation path creates its own organization, agent, tools, policies, session, run, approvals, and replay data over HTTP instead of depending on pre-seeded fixture IDs.
- Why: This exercises the actual admin and authorization surface that users care about, makes CI deterministic across clean databases, and avoids coupling the acceptance path to seed output parsing.
