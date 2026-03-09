import { PrismaClient } from "@prisma/client";

const globalState = globalThis as { prisma?: PrismaClient };

export function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}

export const prisma = globalState.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalState.prisma = prisma;
}
