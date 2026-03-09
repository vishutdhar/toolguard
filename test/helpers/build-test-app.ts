import { buildApp } from "../../src/app";
import { NoopJobQueue } from "../../src/infrastructure/jobs/noop-job-queue";
import { MemoryDataStore } from "../../src/infrastructure/memory/store";
import { MemoryUsageStore } from "../../src/infrastructure/memory/usage-store";
import { seedDemoData, type DemoSeedResult } from "../../src/demo/seed-data";

export async function buildTestApp(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>["app"];
  seed: DemoSeedResult;
  headers: Record<string, string>;
}> {
  const { app, services } = await buildApp({
    env: {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: 3000,
      LOG_LEVEL: "silent",
      DATABASE_URL: "postgresql://toolguard:toolguard@localhost:5432/toolguard?schema=public",
      REDIS_URL: "redis://localhost:6379",
      STORAGE_MODE: "memory",
      ENABLE_SWAGGER: false,
      ALLOW_SELF_SIGNUP: true,
      DEV_DEFAULT_DECISION: "allow",
      PROD_DEFAULT_DECISION: "require_approval",
      APPROVAL_TTL_MINUTES: 60,
      PUBLIC_RATE_LIMIT_MAX: 1000,
      PUBLIC_RATE_LIMIT_WINDOW_SECONDS: 60,
      ORG_DAILY_MAX_ACTIONS: 1000,
      ORG_DAILY_MAX_SPEND_USD: 5000,
      ORG_DAILY_MAX_TOKENS: 500000,
      PER_TOOL_DAILY_MAX_ACTIONS: 200,
      BULLMQ_ENABLED: false,
    },
    store: new MemoryDataStore(),
    usageStore: new MemoryUsageStore(),
    jobQueue: new NoopJobQueue(),
  });

  const seed = await seedDemoData(services.store, services.authService);

  return {
    app,
    seed,
    headers: {
      authorization: `Bearer ${seed.rawApiKey}`,
    },
  };
}
