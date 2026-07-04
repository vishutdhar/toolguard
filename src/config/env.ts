import { z } from "zod";

// Parse a boolean from an environment variable. Unlike z.coerce.boolean()
// (which runs Boolean(), making any non-empty string — including "false" and
// "0" — true), this treats only "true"/"1" as true so operators can actually
// disable a flag. Also accepts real booleans for the programmatic buildApp path.
const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().default("postgresql://toolguard:toolguard@localhost:5432/toolguard?schema=public"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  STORAGE_MODE: z.enum(["memory", "prisma"]).default("prisma"),
  ENABLE_SWAGGER: booleanFromEnv.default(true),
  ALLOW_SELF_SIGNUP: booleanFromEnv.default(true),
  DEV_DEFAULT_DECISION: z.enum(["allow", "deny", "require_approval"]).default("allow"),
  PROD_DEFAULT_DECISION: z.enum(["allow", "deny", "require_approval"]).default("require_approval"),
  APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  PUBLIC_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  PUBLIC_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  ORG_DAILY_MAX_ACTIONS: z.coerce.number().int().positive().default(1000),
  ORG_DAILY_MAX_SPEND_USD: z.coerce.number().positive().default(500),
  ORG_DAILY_MAX_TOKENS: z.coerce.number().int().positive().default(200000),
  PER_TOOL_DAILY_MAX_ACTIONS: z.coerce.number().int().positive().default(200),
  BULLMQ_ENABLED: booleanFromEnv.default(true),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
});

export type AppEnv = z.infer<typeof envSchema>;

export function getEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(source);
}
