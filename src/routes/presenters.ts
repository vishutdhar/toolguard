import type {
  Agent,
  ApiKeyRecord,
  ApprovalRequest,
  AuditEvent,
  Organization,
  Policy,
  PolicyVersion,
  Run,
  Session,
  Tool,
} from "../domain/types";

export function presentOrganization(organization: Organization): Record<string, unknown> {
  return {
    id: organization.id,
    name: organization.name,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

export function presentApiKey(apiKey: ApiKeyRecord): Record<string, unknown> {
  return {
    id: apiKey.id,
    organizationId: apiKey.organizationId,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
    createdAt: apiKey.createdAt.toISOString(),
    revokedAt: apiKey.revokedAt?.toISOString() ?? null,
  };
}

export function presentAgent(agent: Agent): Record<string, unknown> {
  return {
    id: agent.id,
    organizationId: agent.organizationId,
    name: agent.name,
    description: agent.description,
    environment: agent.environment,
    defaultScopes: agent.defaultScopes,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

export function presentSession(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    orgId: session.organizationId,
    agentId: session.agentId,
    userId: session.userId,
    servicePrincipal: session.servicePrincipal,
    environment: session.environment,
    scopes: session.scopes,
    metadata: session.metadata,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
  };
}

export function presentTool(tool: Tool): Record<string, unknown> {
  return {
    id: tool.id,
    organizationId: tool.organizationId,
    name: tool.name,
    action: tool.action,
    resource: tool.resource,
    description: tool.description,
    riskLevel: tool.riskLevel,
    estimatedCostUsd: tool.estimatedCostUsd,
    createdAt: tool.createdAt.toISOString(),
    updatedAt: tool.updatedAt.toISOString(),
  };
}

export function presentPolicy(policy: Policy, versions: PolicyVersion[]): Record<string, unknown> {
  return {
    id: policy.id,
    organizationId: policy.organizationId,
    name: policy.name,
    description: policy.description,
    isActive: policy.isActive,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
    versions: versions.map((version) => ({
      id: version.id,
      policyId: version.policyId,
      versionNumber: version.versionNumber,
      rulesJson: version.rulesJson,
      createdAt: version.createdAt.toISOString(),
    })),
  };
}

export function presentApproval(approval: ApprovalRequest): Record<string, unknown> {
  return {
    id: approval.id,
    organizationId: approval.organizationId,
    sessionId: approval.sessionId,
    runId: approval.runId,
    status: approval.status,
    reasonCodes: approval.reasonCodes,
    toolName: approval.toolName,
    action: approval.action,
    resource: approval.resource,
    justification: approval.justification,
    requestedByAgentId: approval.requestedByAgentId,
    resolvedBy: approval.resolvedBy,
    resolvedAt: approval.resolvedAt?.toISOString() ?? null,
    expiresAt: approval.expiresAt?.toISOString() ?? null,
    createdAt: approval.createdAt.toISOString(),
  };
}

export function presentAuditEvent(event: AuditEvent): Record<string, unknown> {
  return {
    id: event.id,
    organizationId: event.organizationId,
    sessionId: event.sessionId,
    runId: event.runId,
    eventType: event.eventType,
    actorType: event.actorType,
    actorId: event.actorId,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

export function presentRun(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    organizationId: run.organizationId,
    sessionId: run.sessionId,
    promptSummary: run.promptSummary,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    metadata: run.metadata,
  };
}
