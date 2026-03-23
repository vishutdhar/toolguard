import { AppError, assertApp, notFound } from "../lib/errors";
import type { DataStore, PaginatedResult, PaginationOptions } from "../domain/store";
import type { ApprovalRequest, ApprovalStatus } from "../domain/types";
import type { AuditService } from "./audit-service";
import type { WebhookService } from "./webhook-service";
import type { JobQueue } from "../infrastructure/jobs/job-queue";

export class ApprovalService {
  private webhookService: WebhookService | null = null;

  constructor(
    private readonly store: DataStore,
    private readonly auditService: AuditService,
    private readonly jobQueue: JobQueue,
    private readonly approvalTtlMinutes: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  setWebhookService(service: WebhookService): void {
    this.webhookService = service;
  }

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

    this.webhookService?.fireEvent(input.organizationId, "approval.requested", {
      approvalId: approval.id,
      toolName: approval.toolName,
      action: approval.action,
      resource: approval.resource,
      status: approval.status,
      reasonCodes: approval.reasonCodes,
      expiresAt: approval.expiresAt?.toISOString() ?? null,
    }).catch(() => {});

    return approval;
  }

  async get(approvalId: string): Promise<ApprovalRequest> {
    const approval = await this.store.getApprovalRequest(approvalId);
    if (!approval) {
      throw notFound("Approval request", { approvalId });
    }

    return this.expireIfNeeded(approval);
  }

  async list(
    organizationId: string,
    options?: PaginationOptions & { status?: ApprovalRequest["status"] },
  ): Promise<PaginatedResult<ApprovalRequest>> {
    // When listing expired, also sweep pending approvals that may have expired
    // since they're still stored as "pending" and won't match a status=expired filter
    if (options?.status === "expired") {
      const pendingResult = await this.store.listApprovalRequests(organizationId, {
        ...options,
        status: "pending",
        cursor: undefined,
        limit: 100,
      });
      // Expire stale ones (side-effect: updates store)
      await Promise.all(pendingResult.items.map((a) => this.expireIfNeeded(a)));
    }

    const result = await this.store.listApprovalRequests(organizationId, options);

    // Expire any stale pending approvals before returning
    const processed = await Promise.all(result.items.map((a) => this.expireIfNeeded(a)));

    // If caller filtered by status, remove items whose status changed due to expiry
    const filtered = options?.status
      ? processed.filter((a) => a.status === options.status)
      : processed;

    return { items: filtered, cursor: result.cursor };
  }

  async resolve(
    approvalId: string,
    status: Exclude<ApprovalStatus, "pending" | "expired">,
    resolvedBy: string,
    actorType = "api_key",
  ): Promise<ApprovalRequest> {
    const resolvedAt = this.now();
    const updated = await this.store.updateApprovalRequest(approvalId, {
      status,
      resolvedBy,
      resolvedAt,
    }, "pending");

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

    this.webhookService?.fireEvent(updated.organizationId, "approval.resolved", {
      approvalId: updated.id,
      toolName: updated.toolName,
      action: updated.action,
      resource: updated.resource,
      status: updated.status,
      resolvedBy: updated.resolvedBy,
      resolvedAt: resolvedAt.toISOString(),
    }).catch(() => {});

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
