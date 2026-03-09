export interface JobQueue {
  scheduleApprovalExpiry(approvalId: string, delayMs: number): Promise<void>;
  close?(): Promise<void>;
}
