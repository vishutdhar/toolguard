import "dotenv/config";
import Redis from "ioredis";
import { buildApp } from "./app";
import { getEnv } from "./config/env";
import { createPrismaClient } from "./infrastructure/prisma/client";

async function start(): Promise<void> {
  const env = getEnv();
  const prismaClient = env.STORAGE_MODE === "prisma" ? createPrismaClient() : undefined;
  const redisClient =
    env.STORAGE_MODE === "prisma"
      ? new Redis(env.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
        })
      : undefined;

  try {
    if (prismaClient) {
      await prismaClient.$connect();
      await prismaClient.$queryRaw`SELECT 1`;
    }

    if (redisClient) {
      await redisClient.connect();
      await redisClient.ping();
    }
  } catch (error) {
    console.error("Dependency preflight failed", error);
    await redisClient?.quit().catch(() => undefined);
    await prismaClient?.$disconnect().catch(() => undefined);
    process.exit(1);
  }

  const { app, services } = await buildApp({
    env,
    prismaClient,
    redis: redisClient,
  });

  try {
    await app.listen({
      host: services.env.HOST,
      port: services.env.PORT,
    });
  } catch (error) {
    app.log.error(error, "failed to start server");
    await app.close();
    process.exit(1);
  }
}

void start();
