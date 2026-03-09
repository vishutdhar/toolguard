import { ToolGuardError } from "./errors.js";
import type {
  Agent,
  ApiKeyResult,
  Approval,
  AuditEvent,
  AuthorizeInput,
  AuthorizeResult,
  BootstrapResult,
  CheckUsageInput,
  CheckUsageResult,
  CreateAgentInput,
  CreateApiKeyInput,
  CreatePolicyInput,
  CreatePolicyVersionInput,
  CreateRunInput,
  CreateSessionInput,
  CreateToolInput,
  EvaluatePolicyInput,
  EvaluatePolicyResult,
  HealthCheckResult,
  IngestAuditEventInput,
  Policy,
  PolicyVersion,
  ReplayItem,
  RequestApprovalInput,
  Run,
  Session,
  Tool,
  ToolGuardConfig,
} from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:3000";

export class ToolGuard {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultOrgId: string | undefined;
  private readonly defaultAgentId: string | undefined;

  constructor(config: ToolGuardConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultOrgId = config.orgId;
    this.defaultAgentId = config.agentId;
  }

  // --- HTTP ---

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let json: Record<string, unknown>;
    try {
      json = await response.json() as Record<string, unknown>;
    } catch {
      throw new ToolGuardError(
        `Unexpected response from ${method} ${path}: ${response.status} ${response.statusText}`,
        response.status,
        "INVALID_RESPONSE",
      );
    }

    if (!response.ok) {
      throw new ToolGuardError(
        String(json.message ?? response.statusText),
        response.status,
        String(json.error ?? "UNKNOWN_ERROR"),
        (json.details as Record<string, unknown>) ?? null,
      );
    }

    return json as T;
  }

  private orgId(override?: string): string {
    const id = override ?? this.defaultOrgId;
    if (!id) {
      throw new ToolGuardError("orgId is required — pass it explicitly or set it in the constructor", 400, "MISSING_ORG_ID");
    }
    return id;
  }

  private agentId(override?: string): string {
    const id = override ?? this.defaultAgentId;
    if (!id) {
      throw new ToolGuardError("agentId is required — pass it explicitly or set it in the constructor", 400, "MISSING_AGENT_ID");
    }
    return id;
  }

  // --- Health ---

  async health(): Promise<HealthCheckResult> {
    return this.request<HealthCheckResult>("GET", "/healthz");
  }

  // --- Bootstrap ---

  async bootstrap(name: string, apiKeyName = "Default key"): Promise<BootstrapResult> {
    return this.request<BootstrapResult>("POST", "/v1/organizations", { name, apiKeyName });
  }

  // --- API Keys ---

  async createApiKey(input: CreateApiKeyInput): Promise<ApiKeyResult> {
    return this.request<ApiKeyResult>("POST", "/v1/api-keys", {
      orgId: this.orgId(input.orgId),
      name: input.name,
    });
  }

  // --- Agents ---

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    return this.request<Agent>("POST", "/v1/agents", {
      orgId: this.orgId(input.orgId),
      name: input.name,
      description: input.description,
      environment: input.environment,
      defaultScopes: input.defaultScopes ?? [],
    });
  }

  async listAgents(): Promise<Agent[]> {
    const result = await this.request<{ items: Agent[] }>("GET", "/v1/agents");
    return result.items;
  }

  // --- Sessions ---

  async createSession(input: CreateSessionInput): Promise<Session> {
    return this.request<Session>("POST", "/v1/sessions", {
      orgId: this.orgId(input.orgId),
      agentId: this.agentId(input.agentId),
      userId: input.userId ?? null,
      servicePrincipal: input.servicePrincipal ?? null,
      environment: input.environment ?? "production",
      scopes: input.scopes ?? [],
      metadata: input.metadata ?? {},
    });
  }

  // --- Tools ---

  async createTool(input: CreateToolInput): Promise<Tool> {
    return this.request<Tool>("POST", "/v1/tools", {
      orgId: this.orgId(input.orgId),
      name: input.name,
      action: input.action,
      resource: input.resource,
      description: input.description,
      riskLevel: input.riskLevel,
    });
  }

  async listTools(): Promise<Tool[]> {
    const result = await this.request<{ items: Tool[] }>("GET", "/v1/tools");
    return result.items;
  }

  // --- Policies ---

  async createPolicy(input: CreatePolicyInput): Promise<Policy> {
    return this.request<Policy>("POST", "/v1/policies", {
      orgId: this.orgId(input.orgId),
      name: input.name,
      description: input.description,
      isActive: input.isActive ?? true,
      rulesJson: input.rulesJson,
    });
  }

  async getPolicy(policyId: string): Promise<Policy> {
    return this.request<Policy>("GET", `/v1/policies/${encodeURIComponent(policyId)}`);
  }

  async createPolicyVersion(input: CreatePolicyVersionInput): Promise<PolicyVersion> {
    return this.request<PolicyVersion>(
      "POST",
      `/v1/policies/${encodeURIComponent(input.policyId)}/versions`,
      { rulesJson: input.rulesJson },
    );
  }

  // --- Policy Evaluation ---

  async evaluatePolicy(input: EvaluatePolicyInput): Promise<EvaluatePolicyResult> {
    return this.request<EvaluatePolicyResult>("POST", "/v1/policy/evaluate", {
      orgId: this.orgId(input.orgId),
      agentId: this.agentId(input.agentId),
      sessionId: input.sessionId,
      tool: input.tool,
      context: input.context ?? {},
      payloadSummary: input.payloadSummary ?? {},
    });
  }

  // --- Usage ---

  async checkUsage(input: CheckUsageInput): Promise<CheckUsageResult> {
    return this.request<CheckUsageResult>("POST", "/v1/usage/check", {
      orgId: this.orgId(input.orgId),
      toolName: input.toolName,
      estimatedCostUsd: input.estimatedCostUsd ?? 0,
      tokenCount: input.tokenCount ?? 0,
      reserve: input.reserve ?? false,
    });
  }

  // --- Authorization ---

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const raw = await this.request<Omit<AuthorizeResult, "allowed" | "denied" | "pendingApproval">>(
      "POST",
      "/v1/tool/authorize",
      {
        orgId: this.orgId(input.orgId),
        agentId: this.agentId(input.agentId),
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        approvalId: input.approvalId ?? null,
        tool: input.tool,
        context: input.context ?? {},
        payloadSummary: input.payloadSummary ?? {},
        tokenCount: input.tokenCount ?? 0,
      },
    );

    return {
      ...raw,
      allowed: raw.decision === "allow",
      denied: raw.decision === "deny",
      pendingApproval: raw.decision === "require_approval",
    };
  }

  // --- Approvals ---

  async requestApproval(input: RequestApprovalInput): Promise<Approval> {
    return this.request<Approval>("POST", "/v1/approvals/request", {
      orgId: this.orgId(input.orgId),
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      reasonCodes: input.reasonCodes,
      toolName: input.toolName,
      action: input.action,
      resource: input.resource,
      justification: input.justification ?? null,
      requestedByAgentId: input.requestedByAgentId,
    });
  }

  async getApproval(approvalId: string): Promise<Approval> {
    return this.request<Approval>("GET", `/v1/approvals/${encodeURIComponent(approvalId)}`);
  }

  async resolveApproval(approvalId: string, status: "approved" | "rejected"): Promise<Approval> {
    return this.request<Approval>("POST", `/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, { status });
  }

  // --- Runs ---

  async createRun(input: CreateRunInput): Promise<Run> {
    return this.request<Run>("POST", "/v1/runs", {
      orgId: this.orgId(input.orgId),
      sessionId: input.sessionId,
      promptSummary: input.promptSummary ?? null,
      metadata: input.metadata ?? {},
    });
  }

  async completeRun(runId: string, status: "completed" | "failed"): Promise<Run> {
    return this.request<Run>("POST", `/v1/runs/${encodeURIComponent(runId)}/complete`, { status });
  }

  async replay(runId: string): Promise<ReplayItem[]> {
    const result = await this.request<{ items: ReplayItem[] }>("GET", `/v1/runs/${encodeURIComponent(runId)}/replay`);
    return result.items;
  }

  // --- Audit ---

  async ingestAuditEvent(input: IngestAuditEventInput): Promise<AuditEvent> {
    return this.request<AuditEvent>("POST", "/v1/audit/events", {
      orgId: this.orgId(input.orgId),
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      payload: input.payload ?? {},
    });
  }
}
