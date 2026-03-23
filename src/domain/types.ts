import type { JsonObject, JsonValue } from "../lib/json";

export type Decision = "allow" | "deny" | "require_approval";
export type RiskLevel = "low" | "medium" | "high";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type RunStatus = "started" | "completed" | "failed";

export interface Organization {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyRecord {
  id: string;
  organizationId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface Agent {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  environment: string;
  defaultScopes: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Session {
  id: string;
  organizationId: string;
  agentId: string;
  userId: string | null;
  servicePrincipal: string | null;
  environment: string;
  scopes: string[];
  metadata: JsonObject;
  startedAt: Date;
  endedAt: Date | null;
}

export interface Tool {
  id: string;
  organizationId: string;
  name: string;
  action: string;
  resource: string;
  description: string | null;
  riskLevel: RiskLevel;
  estimatedCostUsd: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Policy {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PolicyCondition {
  equals?: JsonValue;
  in?: JsonValue[];
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

export interface PolicyRule {
  if: Record<string, JsonValue | PolicyCondition>;
  then: {
    decision: Decision;
    reasonCodes?: string[];
  };
}

export interface PolicyVersion {
  id: string;
  policyId: string;
  versionNumber: number;
  rulesJson: PolicyRule[];
  createdAt: Date;
}

export interface ApprovalRequest {
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
  resolvedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface AuditEvent {
  id: string;
  organizationId: string;
  sessionId: string | null;
  runId: string | null;
  eventType: string;
  actorType: string;
  actorId: string | null;
  payload: JsonObject;
  createdAt: Date;
}

export interface Run {
  id: string;
  organizationId: string;
  sessionId: string;
  promptSummary: string | null;
  status: RunStatus;
  startedAt: Date;
  completedAt: Date | null;
  metadata: JsonObject;
}

export interface UsageCounter {
  id: string;
  organizationId: string;
  agentId: string | null;
  toolName: string | null;
  windowKey: string;
  scopeKey: string;
  requestCount: number;
  spendUsd: number;
  tokenCount: number;
  updatedAt: Date;
}

export interface LatestPolicyVersion {
  policy: Policy;
  version: PolicyVersion;
}

export interface WebhookConfig {
  id: string;
  organizationId: string;
  url: string;
  eventTypes: string[];
  secret: string | null;
  createdAt: Date;
}
