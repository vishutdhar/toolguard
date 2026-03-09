import { Queue } from "bullmq";
import type { JobQueue } from "./job-queue";

export class BullMqJobQueue implements JobQueue {
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    this.queue = new Queue("approval-expiry", {
      connection: {
        url: redisUrl,
      },
    });
  }

  async scheduleApprovalExpiry(approvalId: string, delayMs: number): Promise<void> {
    await this.queue.add(
      "approval-expiry",
      { approvalId },
      {
        jobId: `approval-expiry-${approvalId}`,
        delay: delayMs,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
