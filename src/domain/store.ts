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
} from "./types";

export interface CreateOrganizationInput {
  name: string;
}

export interface CreateApiKeyInput {
  organizationId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
}

export interface CreateAgentInput {
  organizationId: string;
  name: string;
  description?: string | null;
  environment: string;
  defaultScopes: string[];
}

export interface CreateSessionInput {
  organizationId: string;
  agentId: string;
  userId?: string | null;
  servicePrincipal?: string | null;
  environment: string;
  scopes: string[];
  metadata: Record<string, unknown>;
}

export interface CreateToolInput {
  organizationId: string;
  name: string;
  action: string;
  resource: string;
  description?: string | null;
  riskLevel: "low" | "medium" | "high";
  estimatedCostUsd?: number;
}

export interface CreatePolicyInput {
  organizationId: string;
  name: string;
  description?: string | null;
  isActive?: boolean;
}

export interface CreatePolicyVersionInput {
  policyId: string;
  versionNumber: number;
  rulesJson: PolicyVersion["rulesJson"];
}

export interface CreateApprovalRequestInput {
  organizationId: string;
  sessionId: string;
  runId?: string | null;
  status: ApprovalRequest["status"];
  reasonCodes: string[];
  toolName: string;
  action: string;
  resource: string;
  justification?: string | null;
  requestedByAgentId: string;
  expiresAt?: Date | null;
}

export interface UpdateApprovalRequestInput {
  status: ApprovalRequest["status"];
  resolvedBy?: string | null;
  resolvedAt?: Date | null;
}

export interface CreateAuditEventInput {
  organizationId: string;
  sessionId?: string | null;
  runId?: string | null;
  eventType: string;
  actorType: string;
  actorId?: string | null;
  payload: Record<string, unknown>;
  createdAt?: Date;
}

export interface CreateRunInput {
  organizationId: string;
  sessionId: string;
  promptSummary?: string | null;
  status: Run["status"];
  metadata: Record<string, unknown>;
}

export interface UpdateRunInput {
  status: Run["status"];
  completedAt?: Date | null;
}

export interface UpsertUsageCounterInput {
  organizationId: string;
  agentId?: string | null;
  toolName?: string | null;
  windowKey: string;
  scopeKey: string;
  requestCount: number;
  spendUsd: number;
  tokenCount: number;
}

export interface DataStore {
  createOrganization(input: CreateOrganizationInput): Promise<Organization>;
  getOrganization(id: string): Promise<Organization | null>;

  createApiKey(input: CreateApiKeyInput): Promise<ApiKeyRecord>;
  findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  updateApiKeyLastUsed(id: string, lastUsedAt: Date): Promise<void>;

  createAgent(input: CreateAgentInput): Promise<Agent>;
  getAgent(id: string): Promise<Agent | null>;
  listAgents(organizationId: string): Promise<Agent[]>;

  createSession(input: CreateSessionInput): Promise<Session>;
  getSession(id: string): Promise<Session | null>;

  createTool(input: CreateToolInput): Promise<Tool>;
  listTools(organizationId: string): Promise<Tool[]>;
  findToolByName(organizationId: string, name: string): Promise<Tool | null>;

  createPolicy(input: CreatePolicyInput): Promise<Policy>;
  getPolicy(id: string): Promise<(Policy & { versions: PolicyVersion[] }) | null>;
  createPolicyVersion(input: CreatePolicyVersionInput): Promise<PolicyVersion>;
  listLatestActivePolicyVersions(organizationId: string): Promise<LatestPolicyVersion[]>;

  createApprovalRequest(input: CreateApprovalRequestInput): Promise<ApprovalRequest>;
  getApprovalRequest(id: string): Promise<ApprovalRequest | null>;
  updateApprovalRequest(id: string, input: UpdateApprovalRequestInput, expectedStatus?: ApprovalRequest["status"]): Promise<ApprovalRequest>;

  createAuditEvent(input: CreateAuditEventInput): Promise<AuditEvent>;
  listAuditEventsForRun(runId: string): Promise<AuditEvent[]>;

  createRun(input: CreateRunInput): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  updateRun(id: string, input: UpdateRunInput): Promise<Run>;

  upsertUsageCounter(input: UpsertUsageCounterInput): Promise<UsageCounter>;
}
