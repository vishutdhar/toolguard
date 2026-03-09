import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { ZodTypeProvider, jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import Redis from "ioredis";
import type { PrismaClient } from "@prisma/client";
import { getEnv, type AppEnv } from "./config/env";
import type { DataStore } from "./domain/store";
import type { UsageStore } from "./domain/usage-store";
import { NoopJobQueue } from "./infrastructure/jobs/noop-job-queue";
import { BullMqJobQueue } from "./infrastructure/jobs/bullmq-job-queue";
import type { JobQueue } from "./infrastructure/jobs/job-queue";
import { MemoryDataStore } from "./infrastructure/memory/store";
import { MemoryUsageStore } from "./infrastructure/memory/usage-store";
import { prisma } from "./infrastructure/prisma/client";
import { PrismaDataStore } from "./infrastructure/prisma/store";
import { RedisUsageStore } from "./infrastructure/redis/usage-store";
import { AppError } from "./lib/errors";
import { registerRoutes } from "./routes/register";
import { ApprovalService } from "./services/approval-service";
import { AuditService } from "./services/audit-service";
import { AuthService } from "./services/auth-service";
import { AuthorizationService } from "./services/authorization-service";
import { PolicyService } from "./services/policy-service";
import { ReplayService } from "./services/replay-service";
import { RunService } from "./services/run-service";
import { UsageService } from "./services/usage-service";

export interface BuildAppOptions {
  env?: AppEnv;
  store?: DataStore;
  usageStore?: UsageStore;
  jobQueue?: JobQueue;
  prismaClient?: PrismaClient;
  redis?: Redis;
  fastify?: FastifyServerOptions;
  now?: () => Date;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: {
    env: AppEnv;
    store: DataStore;
    authService: AuthService;
    policyService: PolicyService;
    usageService: UsageService;
    approvalService: ApprovalService;
    auditService: AuditService;
    runService: RunService;
    replayService: ReplayService;
    authorizationService: AuthorizationService;
    healthCheck: () => Promise<{
      status: "ok" | "degraded";
      storageMode: "memory" | "prisma";
      database: "ok" | "down" | "skipped";
      redis: "ok" | "down" | "skipped";
    }>;
  };
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const env = options.env ?? getEnv();
  const now = options.now ?? (() => new Date());
  const store =
    options.store ??
    (env.STORAGE_MODE === "memory"
      ? new MemoryDataStore()
      : new PrismaDataStore(options.prismaClient ?? prisma));

  const ownedRedis =
    !options.usageStore && env.STORAGE_MODE === "prisma"
      ? options.redis ??
        new Redis(env.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
        })
      : undefined;

  const usageStore =
    options.usageStore ??
    (env.STORAGE_MODE === "memory" ? new MemoryUsageStore() : new RedisUsageStore(ownedRedis!));

  const prismaClient = env.STORAGE_MODE === "prisma" ? options.prismaClient ?? prisma : null;
  const redisClient = env.STORAGE_MODE === "prisma" ? ownedRedis ?? options.redis ?? null : null;

  const jobQueue =
    options.jobQueue ??
    (env.BULLMQ_ENABLED && env.STORAGE_MODE === "prisma" ? new BullMqJobQueue(env.REDIS_URL) : new NoopJobQueue());

  const auditService = new AuditService(store);
  const authService = new AuthService(store);
  const policyService = new PolicyService(env.DEV_DEFAULT_DECISION, env.PROD_DEFAULT_DECISION);
  const usageService = new UsageService(
    store,
    usageStore,
    {
      orgDailyMaxActions: env.ORG_DAILY_MAX_ACTIONS,
      orgDailyMaxSpendUsd: env.ORG_DAILY_MAX_SPEND_USD,
      orgDailyMaxTokens: env.ORG_DAILY_MAX_TOKENS,
      perToolDailyMaxActions: env.PER_TOOL_DAILY_MAX_ACTIONS,
    },
    now,
  );
  const approvalService = new ApprovalService(store, auditService, jobQueue, env.APPROVAL_TTL_MINUTES, now);
  const runService = new RunService(store, auditService, now);
  const replayService = new ReplayService(store);
  const authorizationService = new AuthorizationService(
    store,
    policyService,
    usageService,
    approvalService,
    auditService,
  );

  const healthCheck = async () => {
    if (env.STORAGE_MODE === "memory") {
      return {
        status: "ok" as const,
        storageMode: env.STORAGE_MODE,
        database: "skipped" as const,
        redis: "skipped" as const,
      };
    }

    let database: "ok" | "down" = "ok";
    let redis: "ok" | "down" = "ok";

    try {
      if (prismaClient) {
        await prismaClient.$queryRaw`SELECT 1`;
      }
    } catch {
      database = "down";
    }

    try {
      await redisClient?.ping();
    } catch {
      redis = "down";
    }

    return {
      status: database === "ok" && redis === "ok" ? ("ok" as const) : ("degraded" as const),
      storageMode: env.STORAGE_MODE,
      database,
      redis,
    };
  };

  const app = Fastify({
    logger:
      env.NODE_ENV === "test"
        ? false
        : {
            level: env.LOG_LEVEL,
            transport:
              env.NODE_ENV === "development"
                ? {
                    target: "pino-pretty",
                  }
                : undefined,
          },
    requestIdHeader: "x-request-id",
    ...options.fastify,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin: true,
  });

  await app.register(rateLimit, {
    max: env.PUBLIC_RATE_LIMIT_MAX,
    timeWindow: `${env.PUBLIC_RATE_LIMIT_WINDOW_SECONDS} seconds`,
    skipOnError: true,
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "ToolGuard Agent Permissions API",
        version: "0.1.0",
        description:
          "ToolGuard decides whether an AI agent is allowed to call a tool before it emails, buys, edits, executes, or fetches sensitive data.",
      },
      tags: [
        { name: "System", description: "System health and operational endpoints" },
        { name: "Organizations", description: "Organization bootstrap and API key management" },
        { name: "Agents", description: "Agent administration" },
        { name: "Sessions", description: "Agent sessions" },
        { name: "Tools", description: "Tool catalog management" },
        { name: "Policies", description: "Policy CRUD and versioning" },
        { name: "Policy", description: "Policy evaluation" },
        { name: "Authorization", description: "Tool authorization decisions" },
        { name: "Usage", description: "Usage counters and limits" },
        { name: "Approvals", description: "Human approval workflow" },
        { name: "Audit", description: "Audit logging" },
        { name: "Runs", description: "Run lifecycle and replay" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "API Key",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  if (env.ENABLE_SWAGGER) {
    await app.register(swaggerUi, {
      routePrefix: "/docs",
    });
  }

  await registerRoutes(app, {
    env,
    store,
    authService,
    policyService,
    usageService,
    approvalService,
    auditService,
    runService,
    replayService,
    authorizationService,
    healthCheck,
  });

  app.setErrorHandler((error, request, reply) => {
    const normalizedError = error as Partial<AppError> & {
      message?: string;
      validation?: unknown;
    };

    request.log.error(
      {
        err: error,
        code: error instanceof AppError ? error.code : "INTERNAL_SERVER_ERROR",
      },
      "request failed",
    );

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        details: error.details ?? null,
      });
    }

    if ("validation" in normalizedError) {
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        message: "Invalid request payload",
        details: normalizedError.validation ?? null,
      });
    }

    return reply.status(500).send({
      error: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error",
    });
  });

  app.addHook("onClose", async () => {
    await jobQueue.close?.();
    if (ownedRedis) {
      await ownedRedis.quit();
    }
  });

  return {
    app,
    services: {
      env,
      store,
      authService,
      policyService,
      usageService,
      approvalService,
      auditService,
      runService,
      replayService,
      authorizationService,
      healthCheck,
    },
  };
}
