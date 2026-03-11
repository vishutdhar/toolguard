import { PrismaClient, Prisma } from "@prisma/client";
import { toJsonObject, type JsonObject } from "../../lib/json";
import type {
  Agent,
  ApiKeyRecord,
  ApprovalRequest,
  AuditEvent,
  LatestPolicyVersion,
  Organization,
  Policy,
  PolicyRule,
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

function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function policyRules(value: Prisma.JsonValue): PolicyRule[] {
  return Array.isArray(value) ? (value as unknown as PolicyRule[]) : [];
}

function jsonObject(value: Prisma.JsonValue): JsonObject {
  return toJsonObject(value);
}

function inputJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function mapOrganization(record: {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}): Organization {
  return { ...record };
}

function mapApiKey(record: {
  id: string;
  organizationId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}): ApiKeyRecord {
  return { ...record };
}

function mapAgent(record: {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  environment: string;
  defaultScopes: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): Agent {
  return {
    ...record,
    defaultScopes: stringArray(record.defaultScopes),
  };
}

function mapSession(record: {
  id: string;
  organizationId: string;
  agentId: string;
  userId: string | null;
  servicePrincipal: string | null;
  environment: string;
  scopes: Prisma.JsonValue;
  metadata: Prisma.JsonValue;
  startedAt: Date;
  endedAt: Date | null;
}): Session {
  return {
    ...record,
    scopes: stringArray(record.scopes),
    metadata: jsonObject(record.metadata),
  };
}

function mapTool(record: {
  id: string;
  organizationId: string;
  name: string;
  action: string;
  resource: string;
  description: string | null;
  riskLevel: Tool["riskLevel"];
  estimatedCostUsd: { toNumber(): number } | number;
  createdAt: Date;
  updatedAt: Date;
}): Tool {
  return {
    ...record,
    estimatedCostUsd: typeof record.estimatedCostUsd === "number"
      ? record.estimatedCostUsd
      : record.estimatedCostUsd.toNumber(),
  };
}

function mapPolicy(record: {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): Policy {
  return { ...record };
}

function mapPolicyVersion(record: {
  id: string;
  policyId: string;
  versionNumber: number;
  rulesJson: Prisma.JsonValue;
  createdAt: Date;
}): PolicyVersion {
  return {
    ...record,
    rulesJson: policyRules(record.rulesJson),
  };
}

function mapApproval(record: {
  id: string;
  organizationId: string;
  sessionId: string;
  runId: string | null;
  status: ApprovalRequest["status"];
  reasonCodes: Prisma.JsonValue;
  toolName: string;
  action: string;
  resource: string;
  justification: string | null;
  requestedByAgentId: string;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}): ApprovalRequest {
  return {
    ...record,
    reasonCodes: stringArray(record.reasonCodes),
  };
}

function mapAuditEvent(record: {
  id: string;
  organizationId: string;
  sessionId: string | null;
  runId: string | null;
  eventType: string;
  actorType: string;
  actorId: string | null;
  payload: Prisma.JsonValue;
  createdAt: Date;
}): AuditEvent {
  return {
    ...record,
    payload: jsonObject(record.payload),
  };
}

function mapRun(record: {
  id: string;
  organizationId: string;
  sessionId: string;
  promptSummary: string | null;
  status: Run["status"];
  startedAt: Date;
  completedAt: Date | null;
  metadata: Prisma.JsonValue;
}): Run {
  return {
    ...record,
    metadata: jsonObject(record.metadata),
  };
}

function mapUsageCounter(record: {
  id: string;
  organizationId: string;
  agentId: string | null;
  toolName: string | null;
  windowKey: string;
  scopeKey: string;
  requestCount: number;
  spendUsd: Prisma.Decimal;
  tokenCount: number;
  updatedAt: Date;
}): UsageCounter {
  return {
    ...record,
    spendUsd: Number(record.spendUsd),
  };
}

export class PrismaDataStore implements DataStore {
  constructor(private readonly client: PrismaClient) {}

  async createOrganization(input: CreateOrganizationInput): Promise<Organization> {
    return mapOrganization(
      await this.client.organization.create({
        data: { name: input.name },
      }),
    );
  }

  async getOrganization(id: string): Promise<Organization | null> {
    const organization = await this.client.organization.findUnique({ where: { id } });
    return organization ? mapOrganization(organization) : null;
  }

  async createApiKey(input: CreateApiKeyInput): Promise<ApiKeyRecord> {
    return mapApiKey(
      await this.client.apiKey.create({
        data: input,
      }),
    );
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const apiKey = await this.client.apiKey.findUnique({ where: { keyHash } });
    return apiKey ? mapApiKey(apiKey) : null;
  }

  async updateApiKeyLastUsed(id: string, lastUsedAt: Date): Promise<void> {
    await this.client.apiKey.update({
      where: { id },
      data: { lastUsedAt },
    });
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    return mapAgent(
      await this.client.agent.create({
        data: {
          ...input,
          defaultScopes: inputJsonValue(input.defaultScopes),
        },
      }),
    );
  }

  async getAgent(id: string): Promise<Agent | null> {
    const agent = await this.client.agent.findUnique({ where: { id } });
    return agent ? mapAgent(agent) : null;
  }

  async listAgents(organizationId: string): Promise<Agent[]> {
    const agents = await this.client.agent.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
    });
    return agents.map(mapAgent);
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    return mapSession(
      await this.client.session.create({
        data: {
          ...input,
          scopes: inputJsonValue(input.scopes),
          metadata: inputJsonValue(input.metadata),
        },
      }),
    );
  }

  async getSession(id: string): Promise<Session | null> {
    const session = await this.client.session.findUnique({ where: { id } });
    return session ? mapSession(session) : null;
  }

  async createTool(input: CreateToolInput): Promise<Tool> {
    return mapTool(await this.client.tool.create({ data: input }));
  }

  async listTools(organizationId: string): Promise<Tool[]> {
    const tools = await this.client.tool.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
    });
    return tools.map(mapTool);
  }

  async findToolByName(organizationId: string, name: string): Promise<Tool | null> {
    const tool = await this.client.tool.findUnique({
      where: {
        organizationId_name: {
          organizationId,
          name,
        },
      },
    });
    return tool ? mapTool(tool) : null;
  }

  async createPolicy(input: CreatePolicyInput): Promise<Policy> {
    return mapPolicy(await this.client.policy.create({ data: input }));
  }

  async getPolicy(id: string): Promise<(Policy & { versions: PolicyVersion[] }) | null> {
    const policy = await this.client.policy.findUnique({
      where: { id },
      include: {
        versions: {
          orderBy: { versionNumber: "asc" },
        },
      },
    });

    return policy
      ? {
          ...mapPolicy(policy),
          versions: policy.versions.map(mapPolicyVersion),
        }
      : null;
  }

  async createPolicyVersion(input: CreatePolicyVersionInput): Promise<PolicyVersion> {
    return mapPolicyVersion(
      await this.client.policyVersion.create({
        data: {
          ...input,
          rulesJson: inputJsonValue(input.rulesJson),
        },
      }),
    );
  }

  async listLatestActivePolicyVersions(organizationId: string): Promise<LatestPolicyVersion[]> {
    const policies = await this.client.policy.findMany({
      where: { organizationId, isActive: true },
      include: {
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return policies.flatMap((policyRecord) =>
      policyRecord.versions.length > 0
        ? [{ policy: mapPolicy(policyRecord), version: mapPolicyVersion(policyRecord.versions[0]) }]
        : [],
    );
  }

  async createApprovalRequest(input: CreateApprovalRequestInput): Promise<ApprovalRequest> {
    return mapApproval(
      await this.client.approvalRequest.create({
        data: {
          ...input,
          reasonCodes: inputJsonValue(input.reasonCodes),
        },
      }),
    );
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequest | null> {
    const approval = await this.client.approvalRequest.findUnique({ where: { id } });
    return approval ? mapApproval(approval) : null;
  }

  async updateApprovalRequest(id: string, input: UpdateApprovalRequestInput, expectedStatus?: ApprovalRequest["status"]): Promise<ApprovalRequest> {
    if (expectedStatus !== undefined) {
      // Atomic compare-and-swap: only update if current status matches
      const result = await this.client.approvalRequest.updateMany({
        where: { id, status: expectedStatus },
        data: input,
      });
      if (result.count === 0) {
        throw Object.assign(
          new Error(`Approval status has changed (expected ${expectedStatus})`),
          { statusCode: 409, code: "APPROVAL_STATUS_CHANGED" },
        );
      }
      // Fetch the updated record to return
      const updated = await this.client.approvalRequest.findUniqueOrThrow({ where: { id } });
      return mapApproval(updated);
    }

    return mapApproval(
      await this.client.approvalRequest.update({
        where: { id },
        data: input,
      }),
    );
  }

  async createAuditEvent(input: CreateAuditEventInput): Promise<AuditEvent> {
    return mapAuditEvent(
      await this.client.auditEvent.create({
        data: {
          ...input,
          payload: inputJsonValue(input.payload),
          createdAt: input.createdAt,
        },
      }),
    );
  }

  async listAuditEventsForRun(runId: string): Promise<AuditEvent[]> {
    const auditEvents = await this.client.auditEvent.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
    });
    return auditEvents.map(mapAuditEvent);
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    return mapRun(
      await this.client.run.create({
        data: {
          ...input,
          metadata: inputJsonValue(input.metadata),
        },
      }),
    );
  }

  async getRun(id: string): Promise<Run | null> {
    const run = await this.client.run.findUnique({ where: { id } });
    return run ? mapRun(run) : null;
  }

  async updateRun(id: string, input: UpdateRunInput): Promise<Run> {
    return mapRun(
      await this.client.run.update({
        where: { id },
        data: input,
      }),
    );
  }

  async upsertUsageCounter(input: UpsertUsageCounterInput): Promise<UsageCounter> {
    return mapUsageCounter(
      await this.client.usageCounter.upsert({
        where: { scopeKey: input.scopeKey },
        update: {
          agentId: input.agentId ?? null,
          toolName: input.toolName ?? null,
          windowKey: input.windowKey,
          requestCount: input.requestCount,
          spendUsd: new Prisma.Decimal(input.spendUsd),
          tokenCount: input.tokenCount,
        },
        create: {
          organizationId: input.organizationId,
          agentId: input.agentId ?? null,
          toolName: input.toolName ?? null,
          windowKey: input.windowKey,
          scopeKey: input.scopeKey,
          requestCount: input.requestCount,
          spendUsd: new Prisma.Decimal(input.spendUsd),
          tokenCount: input.tokenCount,
        },
      }),
    );
  }
}
