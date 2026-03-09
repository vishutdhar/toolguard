import { AppError, assertApp, notFound } from "../lib/errors";
import type { DataStore } from "../domain/store";
import type { ApprovalRequest, ApprovalStatus } from "../domain/types";
import type { AuditService } from "./audit-service";
import type { JobQueue } from "../infrastructure/jobs/job-queue";

export class ApprovalService {
  constructor(
    private readonly store: DataStore,
    private readonly auditService: AuditService,
    private readonly jobQueue: JobQueue,
    private readonly approvalTtlMinutes: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: {
    organizationId: string;
    sessionId: string;
    runId?: string | null;
    reasonCodes: string[];
    toolName: string;
    action: string;
    resource: string;
    justification?: string | null;
    requestedByAgentId: string;
  }): Promise<ApprovalRequest> {
    const session = await this.store.getSession(input.sessionId);
    const agent = await this.store.getAgent(input.requestedByAgentId);
    const run = input.runId ? await this.store.getRun(input.runId) : null;

    assertApp(session, "Session not found", 404, "SESSION_NOT_FOUND");
    assertApp(session.organizationId === input.organizationId, "Session organization mismatch", 409, "SESSION_ORG_MISMATCH");
    assertApp(agent, "Agent not found", 404, "AGENT_NOT_FOUND");
    assertApp(agent.organizationId === input.organizationId, "Agent organization mismatch", 409, "AGENT_ORG_MISMATCH");
    assertApp(session.agentId === agent.id, "Approval agent mismatch", 409, "APPROVAL_AGENT_MISMATCH");

    if (input.runId) {
      assertApp(run, "Run not found", 404, "RUN_NOT_FOUND");
      assertApp(run.organizationId === input.organizationId, "Run organization mismatch", 409, "RUN_ORG_MISMATCH");
      assertApp(run.sessionId === session.id, "Run session mismatch", 409, "RUN_SESSION_MISMATCH");
    }

    const expiresAt = new Date(this.now().getTime() + this.approvalTtlMinutes * 60_000);
    const approval = await this.store.createApprovalRequest({
      ...input,
      status: "pending",
      expiresAt,
    });

    await this.auditService.log({
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      eventType: "approval.requested",
      actorType: "agent",
      actorId: input.requestedByAgentId,
      payload: {
        approvalId: approval.id,
        toolName: input.toolName,
        reasonCodes: input.reasonCodes,
        expiresAt: expiresAt.toISOString(),
      },
    });

    await this.jobQueue.scheduleApprovalExpiry(approval.id, this.approvalTtlMinutes * 60_000);

    return approval;
  }

  async get(approvalId: string): Promise<ApprovalRequest> {
    const approval = await this.store.getApprovalRequest(approvalId);
    if (!approval) {
      throw notFound("Approval request", { approvalId });
    }

    return this.expireIfNeeded(approval);
  }

  async resolve(
    approvalId: string,
    status: Exclude<ApprovalStatus, "pending" | "expired">,
    resolvedBy: string,
    actorType = "api_key",
  ): Promise<ApprovalRequest> {
    const approval = await this.get(approvalId);
    assertApp(approval.status === "pending", "Only pending approvals can be resolved", 409, "APPROVAL_NOT_PENDING");

    const resolvedAt = this.now();
    const updated = await this.store.updateApprovalRequest(approvalId, {
      status,
      resolvedBy,
      resolvedAt,
    });

    await this.auditService.log({
      organizationId: updated.organizationId,
      sessionId: updated.sessionId,
      runId: updated.runId,
      eventType: "approval.resolved",
      actorType,
      actorId: resolvedBy,
      payload: {
        approvalId: updated.id,
        status: updated.status,
        resolvedAt: resolvedAt.toISOString(),
      },
    });

    return updated;
  }

  async validateApprovedApproval(input: {
    approvalId: string;
    organizationId: string;
    sessionId: string;
    toolName: string;
    action: string;
    resource: string;
  }): Promise<ApprovalRequest> {
    const approval = await this.get(input.approvalId);
    assertApp(approval.organizationId === input.organizationId, "Approval does not match organization", 409, "APPROVAL_ORG_MISMATCH");
    assertApp(approval.sessionId === input.sessionId, "Approval does not match session", 409, "APPROVAL_SESSION_MISMATCH");
    assertApp(approval.toolName === input.toolName, "Approval does not match tool", 409, "APPROVAL_TOOL_MISMATCH");
    assertApp(approval.action === input.action, "Approval does not match action", 409, "APPROVAL_ACTION_MISMATCH");
    assertApp(approval.resource === input.resource, "Approval does not match resource", 409, "APPROVAL_RESOURCE_MISMATCH");

    if (approval.status !== "approved") {
      throw new AppError("Approval is not approved", 409, "APPROVAL_NOT_APPROVED");
    }

    return approval;
  }

  async validateApprovalBinding(input: {
    approvalId: string;
    organizationId: string;
    sessionId: string;
    toolName: string;
    action: string;
    resource: string;
  }): Promise<ApprovalRequest> {
    const approval = await this.get(input.approvalId);

    assertApp(approval.organizationId === input.organizationId, "Approval does not match organization", 409, "APPROVAL_ORG_MISMATCH");
    assertApp(approval.sessionId === input.sessionId, "Approval does not match session", 409, "APPROVAL_SESSION_MISMATCH");
    assertApp(approval.toolName === input.toolName, "Approval does not match tool", 409, "APPROVAL_TOOL_MISMATCH");
    assertApp(approval.action === input.action, "Approval does not match action", 409, "APPROVAL_ACTION_MISMATCH");
    assertApp(approval.resource === input.resource, "Approval does not match resource", 409, "APPROVAL_RESOURCE_MISMATCH");

    return approval;
  }

  private async expireIfNeeded(approval: ApprovalRequest): Promise<ApprovalRequest> {
    if (approval.status !== "pending" || !approval.expiresAt || approval.expiresAt > this.now()) {
      return approval;
    }

    const expired = await this.store.updateApprovalRequest(approval.id, {
      status: "expired",
      resolvedAt: this.now(),
    });

    await this.auditService.log({
      organizationId: expired.organizationId,
      sessionId: expired.sessionId,
      runId: expired.runId,
      eventType: "approval.expired",
      actorType: "system",
      actorId: null,
      payload: {
        approvalId: expired.id,
      },
    });

    return expired;
  }
}
