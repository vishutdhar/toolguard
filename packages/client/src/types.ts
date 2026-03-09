export type Decision = "allow" | "deny" | "require_approval";
export type RiskLevel = "low" | "medium" | "high";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ToolGuardConfig {
  /** API key. Optional only for bootstrap (org creation). Required for all other calls. */
  apiKey?: string;
  baseUrl?: string;
  orgId?: string;
  agentId?: string;
}

// --- Inputs ---

export interface CreateAgentInput {
  orgId?: string;
  name: string;
  description?: string;
  environment: string;
  defaultScopes?: string[];
}

export interface CreateSessionInput {
  orgId?: string;
  agentId?: string;
  userId?: string;
  servicePrincipal?: string;
  environment?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateToolInput {
  orgId?: string;
  name: string;
  action: string;
  resource: string;
  description?: string;
  riskLevel: RiskLevel;
}

export interface PolicyRuleInput {
  if: Record<string, unknown>;
  then: {
    decision: Decision;
    reasonCodes?: string[];
  };
}

export interface CreatePolicyInput {
  orgId?: string;
  name: string;
  description?: string;
  isActive?: boolean;
  rulesJson?: PolicyRuleInput[];
}

export interface AuthorizeInput {
  orgId?: string;
  agentId?: string;
  sessionId: string;
  runId?: string;
  approvalId?: string;
  tool: {
    name: string;
    action?: string;
    resource?: string;
    riskLevel?: RiskLevel;
    estimatedCostUsd?: number;
  };
  context?: Record<string, unknown>;
  payloadSummary?: Record<string, unknown>;
  tokenCount?: number;
}

export interface CreateRunInput {
  orgId?: string;
  sessionId: string;
  promptSummary?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateApiKeyInput {
  orgId?: string;
  name: string;
}

export interface CreatePolicyVersionInput {
  policyId: string;
  rulesJson: PolicyRuleInput[];
}

export interface EvaluatePolicyInput {
  orgId?: string;
  agentId?: string;
  sessionId: string;
  tool: {
    name: string;
    action?: string;
    resource?: string;
    riskLevel?: RiskLevel;
    estimatedCostUsd?: number;
  };
  context?: Record<string, unknown>;
  payloadSummary?: Record<string, unknown>;
}

export interface CheckUsageInput {
  orgId?: string;
  toolName: string;
  estimatedCostUsd?: number;
  tokenCount?: number;
  reserve?: boolean;
}

export interface RequestApprovalInput {
  orgId?: string;
  sessionId: string;
  runId?: string;
  reasonCodes: string[];
  toolName: string;
  action: string;
  resource: string;
  justification?: string;
  requestedByAgentId: string;
}

export interface IngestAuditEventInput {
  orgId?: string;
  sessionId?: string;
  runId?: string;
  eventType: string;
  actorType: string;
  actorId?: string;
  payload?: Record<string, unknown>;
}

// --- Responses ---

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  environment: string;
  defaultScopes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  orgId: string;
  agentId: string;
  userId: string | null;
  servicePrincipal: string | null;
  environment: string;
  scopes: string[];
  metadata: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
}

export interface Tool {
  id: string;
  organizationId: string;
  name: string;
  action: string;
  resource: string;
  description: string | null;
  riskLevel: RiskLevel;
  createdAt: string;
  updatedAt: string;
}

export interface Policy {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  versions: PolicyVersion[];
}

export interface PolicyVersion {
  id: string;
  policyId: string;
  versionNumber: number;
  rulesJson: PolicyRuleInput[];
  createdAt: string;
}

export interface Limits {
  remainingActionsToday: number;
  remainingBudgetUsd: number;
  remainingToolActionsToday: number;
  remainingTokensToday: number;
}

export interface AuthorizeResult {
  decision: Decision;
  reasonCodes: string[];
  policyVersionId: string | null;
  matchedRuleIndex: number | null;
  approvalId: string | null;
  approvalStatus: ApprovalStatus | null;
  limits: Limits;
  /** true when decision is "allow" */
  allowed: boolean;
  /** true when decision is "deny" */
  denied: boolean;
  /** true when decision is "require_approval" */
  pendingApproval: boolean;
}

export interface Run {
  id: string;
  organizationId: string;
  sessionId: string;
  promptSummary: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface Approval {
  id: string;
  organizationId: string;
  sessionId: string;
  runId: string | null;
  status: ApprovalStatus;
  reasonCodes: string[];
  toolName: string;
  action: string;
  resource: string;
  justification: string | null;
  requestedByAgentId: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ReplayItem {
  timestamp: string;
  eventType: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface BootstrapResult {
  organization: Organization;
  apiKey: Record<string, unknown>;
  rawApiKey: string;
}

export interface ApiKeyResult {
  apiKey: Record<string, unknown>;
  rawApiKey: string;
}

export interface EvaluatePolicyResult {
  decision: Decision;
  reasonCodes: string[];
  policyVersionId: string | null;
  matchedRuleIndex: number | null;
  limits: Limits;
}

export interface CheckUsageResult {
  allowed: boolean;
  reasonCodes: string[];
  windowKey: string;
  limits: Limits;
}

export interface AuditEvent {
  id: string;
  organizationId: string;
  sessionId: string | null;
  runId: string | null;
  eventType: string;
  actorType: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface HealthCheckResult {
  status: "ok" | "degraded";
  service: string;
  storageMode: string;
  dependencies: {
    database: "ok" | "down" | "skipped";
    redis: "ok" | "down" | "skipped";
  };
}
