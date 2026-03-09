import type { JobQueue } from "./job-queue";

export class NoopJobQueue implements JobQueue {
  async scheduleApprovalExpiry(): Promise<void> {
    return Promise.resolve();
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}
