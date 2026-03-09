import { notFound } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { toJsonObject } from "../../lib/json";
import type {
  Agent,
  ApiKeyRecord,
  ApprovalRequest,
  AuditEvent,
  LatestPolicyVersion,
  Organization,
  Policy,
  PolicyVersion,
  Run,
  Session,
  Tool,
  UsageCounter,
} from "../../domain/types";
import type {
  CreateAgentInput,
  CreateApiKeyInput,
  CreateApprovalRequestInput,
  CreateAuditEventInput,
  CreateOrganizationInput,
  CreatePolicyInput,
  CreatePolicyVersionInput,
  CreateRunInput,
  CreateSessionInput,
  CreateToolInput,
  DataStore,
  UpdateApprovalRequestInput,
  UpdateRunInput,
  UpsertUsageCounterInput,
} from "../../domain/store";

export class MemoryDataStore implements DataStore {
  private readonly organizations = new Map<string, Organization>();
  private readonly apiKeys = new Map<string, ApiKeyRecord>();
  private readonly agents = new Map<string, Agent>();
  private readonly sessions = new Map<string, Session>();
  private readonly tools = new Map<string, Tool>();
  private readonly policies = new Map<string, Policy>();
  private readonly policyVersions = new Map<string, PolicyVersion>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly auditEvents = new Map<string, AuditEvent>();
  private readonly runs = new Map<string, Run>();
  private readonly usageCounters = new Map<string, UsageCounter>();

  async createOrganization(input: CreateOrganizationInput): Promise<Organization> {
    const organization: Organization = {
      id: generateId("org"),
      name: input.name,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.organizations.set(organization.id, organization);
    return { ...organization };
  }

  async getOrganization(id: string): Promise<Organization | null> {
    const organization = this.organizations.get(id);
    return organization ? { ...organization } : null;
  }

  async createApiKey(input: CreateApiKeyInput): Promise<ApiKeyRecord> {
    const apiKey: ApiKeyRecord = {
      id: generateId("key"),
      organizationId: input.organizationId,
      name: input.name,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: null,
    };
    this.apiKeys.set(apiKey.id, apiKey);
    return { ...apiKey };
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const record = [...this.apiKeys.values()].find((item) => item.keyHash === keyHash) ?? null;
    return record ? { ...record } : null;
  }

  async updateApiKeyLastUsed(id: string, lastUsedAt: Date): Promise<void> {
    const record = this.apiKeys.get(id);
    if (!record) {
      throw notFound("API key", { id });
    }
    record.lastUsedAt = lastUsedAt;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const agent: Agent = {
      id: generateId("agent"),
      organizationId: input.organizationId,
      name: input.name,
      description: input.description ?? null,
      environment: input.environment,
      defaultScopes: [...input.defaultScopes],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.agents.set(agent.id, agent);
    return { ...agent, defaultScopes: [...agent.defaultScopes] };
  }

  async getAgent(id: string): Promise<Agent | null> {
    const agent = this.agents.get(id);
    return agent ? { ...agent, defaultScopes: [...agent.defaultScopes] } : null;
  }

  async listAgents(organizationId: string): Promise<Agent[]> {
    return [...this.agents.values()]
      .filter((agent) => agent.organizationId === organizationId)
      .map((agent) => ({ ...agent, defaultScopes: [...agent.defaultScopes] }));
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const session: Session = {
      id: generateId("sess"),
      organizationId: input.organizationId,
      agentId: input.agentId,
      userId: input.userId ?? null,
      servicePrincipal: input.servicePrincipal ?? null,
      environment: input.environment,
      scopes: [...input.scopes],
      metadata: toJsonObject(input.metadata),
      startedAt: new Date(),
      endedAt: null,
    };
    this.sessions.set(session.id, session);
    return { ...session, scopes: [...session.scopes], metadata: { ...session.metadata } };
  }

  async getSession(id: string): Promise<Session | null> {
    const session = this.sessions.get(id);
    return session ? { ...session, scopes: [...session.scopes], metadata: { ...session.metadata } } : null;
  }

  async createTool(input: CreateToolInput): Promise<Tool> {
    const tool: Tool = {
      id: generateId("tool"),
      organizationId: input.organizationId,
      name: input.name,
      action: input.action,
      resource: input.resource,
      description: input.description ?? null,
      riskLevel: input.riskLevel,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tools.set(tool.id, tool);
    return { ...tool };
  }

  async listTools(organizationId: string): Promise<Tool[]> {
    return [...this.tools.values()].filter((tool) => tool.organizationId === organizationId).map((tool) => ({ ...tool }));
  }

  async findToolByName(organizationId: string, name: string): Promise<Tool | null> {
    const tool = [...this.tools.values()].find((item) => item.organizationId === organizationId && item.name === name) ?? null;
    return tool ? { ...tool } : null;
  }

  async createPolicy(input: CreatePolicyInput): Promise<Policy> {
    const policy: Policy = {
      id: generateId("policy"),
      organizationId: input.organizationId,
      name: input.name,
      description: input.description ?? null,
      isActive: input.isActive ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.policies.set(policy.id, policy);
    return { ...policy };
  }

  async getPolicy(id: string): Promise<(Policy & { versions: PolicyVersion[] }) | null> {
    const policy = this.policies.get(id);
    if (!policy) {
      return null;
    }

    const versions = [...this.policyVersions.values()]
      .filter((version) => version.policyId === id)
      .sort((left, right) => left.versionNumber - right.versionNumber)
      .map((version) => ({ ...version, rulesJson: [...version.rulesJson] }));

    return { ...policy, versions };
  }

  async createPolicyVersion(input: CreatePolicyVersionInput): Promise<PolicyVersion> {
    const version: PolicyVersion = {
      id: generateId("polv"),
      policyId: input.policyId,
      versionNumber: input.versionNumber,
      rulesJson: [...input.rulesJson],
      createdAt: new Date(),
    };
    this.policyVersions.set(version.id, version);
    return { ...version, rulesJson: [...version.rulesJson] };
  }

  async listLatestActivePolicyVersions(organizationId: string): Promise<LatestPolicyVersion[]> {
    return [...this.policies.values()]
      .filter((policy) => policy.organizationId === organizationId && policy.isActive)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .flatMap((policy) => {
        const latest = [...this.policyVersions.values()]
          .filter((version) => version.policyId === policy.id)
          .sort((left, right) => right.versionNumber - left.versionNumber)[0];

        return latest ? [{ policy: { ...policy }, version: { ...latest, rulesJson: [...latest.rulesJson] } }] : [];
      });
  }

  async createApprovalRequest(input: CreateApprovalRequestInput): Promise<ApprovalRequest> {
    const approval: ApprovalRequest = {
      id: generateId("approval"),
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      status: input.status,
      reasonCodes: [...input.reasonCodes],
      toolName: input.toolName,
      action: input.action,
      resource: input.resource,
      justification: input.justification ?? null,
      requestedByAgentId: input.requestedByAgentId,
      resolvedBy: null,
      resolvedAt: null,
      expiresAt: input.expiresAt ?? null,
      createdAt: new Date(),
    };
    this.approvals.set(approval.id, approval);
    return { ...approval, reasonCodes: [...approval.reasonCodes] };
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequest | null> {
    const approval = this.approvals.get(id);
    return approval ? { ...approval, reasonCodes: [...approval.reasonCodes] } : null;
  }

  async updateApprovalRequest(id: string, input: UpdateApprovalRequestInput): Promise<ApprovalRequest> {
    const approval = this.approvals.get(id);
    if (!approval) {
      throw notFound("Approval request", { id });
    }

    approval.status = input.status;
    approval.resolvedBy = input.resolvedBy ?? approval.resolvedBy;
    approval.resolvedAt = input.resolvedAt ?? approval.resolvedAt;

    return { ...approval, reasonCodes: [...approval.reasonCodes] };
  }

  async createAuditEvent(input: CreateAuditEventInput): Promise<AuditEvent> {
    const auditEvent: AuditEvent = {
      id: generateId("audit"),
      organizationId: input.organizationId,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      payload: toJsonObject(input.payload),
      createdAt: input.createdAt ?? new Date(),
    };
    this.auditEvents.set(auditEvent.id, auditEvent);
    return { ...auditEvent, payload: { ...auditEvent.payload } };
  }

  async listAuditEventsForRun(runId: string): Promise<AuditEvent[]> {
    return [...this.auditEvents.values()]
      .filter((event) => event.runId === runId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((event) => ({ ...event, payload: { ...event.payload } }));
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const run: Run = {
      id: generateId("run"),
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      promptSummary: input.promptSummary ?? null,
      status: input.status,
      startedAt: new Date(),
      completedAt: null,
      metadata: toJsonObject(input.metadata),
    };
    this.runs.set(run.id, run);
    return { ...run, metadata: { ...run.metadata } };
  }

  async getRun(id: string): Promise<Run | null> {
    const run = this.runs.get(id);
    return run ? { ...run, metadata: { ...run.metadata } } : null;
  }

  async updateRun(id: string, input: UpdateRunInput): Promise<Run> {
    const run = this.runs.get(id);
    if (!run) {
      throw notFound("Run", { id });
    }

    run.status = input.status;
    if (input.completedAt !== undefined) {
      run.completedAt = input.completedAt;
    }

    return { ...run, metadata: { ...run.metadata } };
  }

  async upsertUsageCounter(input: UpsertUsageCounterInput): Promise<UsageCounter> {
    const existing = this.usageCounters.get(input.scopeKey);
    const counter: UsageCounter = {
      id: existing?.id ?? generateId("usage"),
      organizationId: input.organizationId,
      agentId: input.agentId ?? null,
      toolName: input.toolName ?? null,
      windowKey: input.windowKey,
      scopeKey: input.scopeKey,
      requestCount: input.requestCount,
      spendUsd: input.spendUsd,
      tokenCount: input.tokenCount,
      updatedAt: new Date(),
    };
    this.usageCounters.set(input.scopeKey, counter);
    return { ...counter };
  }
}
