import "dotenv/config";
import { Worker } from "bullmq";
import { getEnv } from "./config/env";
import { BullMqJobQueue } from "./infrastructure/jobs/bullmq-job-queue";
import { prisma } from "./infrastructure/prisma/client";
import { PrismaDataStore } from "./infrastructure/prisma/store";
import { ApprovalService } from "./services/approval-service";
import { AuditService } from "./services/audit-service";

async function main(): Promise<void> {
  const env = getEnv();

  if (!env.BULLMQ_ENABLED) {
    console.log("BullMQ worker disabled");
    return;
  }

  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;

  const store = new PrismaDataStore(prisma);
  const auditService = new AuditService(store);
  const jobQueue = new BullMqJobQueue(env.REDIS_URL);
  const approvalService = new ApprovalService(store, auditService, jobQueue, env.APPROVAL_TTL_MINUTES);

  const worker = new Worker(
    "approval-expiry",
    async (job) => {
      const approvalId = String(job.data.approvalId ?? "");
      if (!approvalId) {
        return;
      }

      await approvalService.get(approvalId);
    },
    {
      connection: {
        url: env.REDIS_URL,
      },
    },
  );

  worker.on("error", async (error) => {
    console.error("BullMQ worker error", error);
    await worker.close();
    await jobQueue.close?.();
    await prisma.$disconnect();
    process.exit(1);
  });

  await worker.waitUntilReady();
  console.log("BullMQ worker ready");

  worker.on("completed", (job) => {
    console.log(`Processed approval expiry job ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`Approval expiry job failed for ${job?.id ?? "unknown"}`, error);
  });

  const shutdown = async () => {
    await worker.close();
    await jobQueue.close?.();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (error) => {
  console.error("Worker failed to start", error);
  await prisma.$disconnect();
  process.exit(1);
});
