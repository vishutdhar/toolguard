import { AppError, assertApp, notFound } from "../lib/errors";
import type { DataStore } from "../domain/store";
import type { Agent, ApprovalStatus, Decision, Organization, RiskLevel, Run, Session, Tool } from "../domain/types";
import type { ApprovalService } from "./approval-service";
import type { AuditService } from "./audit-service";
import type { PolicyEvaluationRequest, PolicyService } from "./policy-service";
import type { LimitsSnapshot, UsageService } from "./usage-service";

export interface AuthorizeToolInput extends Omit<PolicyEvaluationRequest, "tool"> {
  tool: {
    name: string;
    action?: string;
    resource?: string;
    riskLevel?: RiskLevel;
    estimatedCostUsd?: number;
  };
  runId?: string | null;
  approvalId?: string | null;
  tokenCount?: number;
}

export interface AuthorizeToolResult {
  decision: Decision;
  reasonCodes: string[];
  policyVersionId: string | null;
  matchedRuleIndex: number | null;
  approvalId: string | null;
  approvalStatus: ApprovalStatus | null;
  limits: LimitsSnapshot;
}

const emptyLimits: LimitsSnapshot = {
  remainingActionsToday: 0,
  remainingBudgetUsd: 0,
  remainingToolActionsToday: 0,
  remainingTokensToday: 0,
};

type ResolvedAuthorizeContext = {
  organization: Organization;
  session: Session;
  agent: Agent;
  run: Run | null;
  tool: Tool;
  estimatedCostUsd: number;
  tokenCount: number;
  policyContext: Record<string, unknown>;
};

export class AuthorizationService {
  constructor(
    private readonly store: DataStore,
    private readonly policyService: PolicyService,
    private readonly usageService: UsageService,
    private readonly approvalService: ApprovalService,
    private readonly auditService: AuditService,
  ) {}

  async authorize(input: AuthorizeToolInput): Promise<AuthorizeToolResult> {
    const resolved = await this.resolveContext(input);
    const { organization, session, agent, run, tool, estimatedCostUsd, tokenCount, policyContext } = resolved;

    await this.auditService.log({
      organizationId: organization.id,
      sessionId: session.id,
      runId: run?.id ?? null,
      eventType: "tool.authorization.requested",
      actorType: "agent",
      actorId: agent.id,
      payload: {
        tool: {
          name: tool.name,
          action: tool.action,
          resource: tool.resource,
          riskLevel: tool.riskLevel,
          estimatedCostUsd,
        },
        approvalId: input.approvalId ?? null,
      },
    });

    const requiredScopes = this.getRequiredScopes(tool);
    if (!this.hasScope(session.scopes, requiredScopes)) {
      await this.logToolDecision("tool.denied", organization.id, session.id, run?.id ?? null, agent.id, {
        reasonCodes: ["SESSION_SCOPE_MISSING"],
        toolName: tool.name,
        requiredScopes,
      });

      return {
        decision: "deny",
        reasonCodes: ["SESSION_SCOPE_MISSING"],
        policyVersionId: null,
        matchedRuleIndex: null,
        approvalId: null,
        approvalStatus: null,
        limits: emptyLimits,
      };
    }

    const evaluation = this.policyService.evaluate(await this.store.listLatestActivePolicyVersions(organization.id), {
      ...input,
      tool: {
        name: tool.name,
        action: tool.action,
        resource: tool.resource,
        riskLevel: tool.riskLevel,
        estimatedCostUsd,
      },
      context: {
        ...policyContext,
      },
    });

    await this.auditService.log({
      organizationId: organization.id,
      sessionId: session.id,
      runId: run?.id ?? null,
      eventType: "policy.evaluated",
      actorType: "system",
      actorId: null,
      payload: {
        decision: evaluation.decision,
        reasonCodes: evaluation.reasonCodes,
        policyVersionId: evaluation.matchedPolicyVersionId,
        matchedRuleIndex: evaluation.matchedRuleIndex,
      },
    });

    if (evaluation.decision === "deny") {
      await this.logToolDecision("tool.denied", organization.id, session.id, run?.id ?? null, agent.id, {
        reasonCodes: evaluation.reasonCodes,
        toolName: input.tool.name,
      });

      return {
        decision: "deny",
        reasonCodes: evaluation.reasonCodes,
        policyVersionId: evaluation.matchedPolicyVersionId,
        matchedRuleIndex: evaluation.matchedRuleIndex,
        approvalId: null,
        approvalStatus: null,
        limits: emptyLimits,
      };
    }

    const usagePreview = await this.usageService.checkUsage({
      organizationId: organization.id,
      toolName: tool.name,
      estimatedCostUsd,
      tokenCount,
      reserve: false,
    });

    if (!usagePreview.allowed) {
      await this.logToolDecision("tool.denied", organization.id, session.id, run?.id ?? null, agent.id, {
        reasonCodes: usagePreview.reasonCodes,
        toolName: input.tool.name,
      });

      return {
        decision: "deny",
        reasonCodes: usagePreview.reasonCodes,
        policyVersionId: evaluation.matchedPolicyVersionId,
        matchedRuleIndex: evaluation.matchedRuleIndex,
        approvalId: null,
        approvalStatus: null,
        limits: usagePreview.limits,
      };
    }

    const approvedByOverride = await this.handleApprovalOverride({
      approvalId: input.approvalId ?? null,
      organizationId: organization.id,
      sessionId: session.id,
      toolName: tool.name,
      action: tool.action,
      resource: tool.resource,
    });

    if (evaluation.decision === "require_approval" && !approvedByOverride.approved) {
      if (approvedByOverride.approvalStatus === "rejected") {
        await this.logToolDecision("tool.denied", organization.id, session.id, run?.id ?? null, agent.id, {
          reasonCodes: ["APPROVAL_REJECTED"],
          toolName: input.tool.name,
          approvalId: approvedByOverride.approvalId,
        });

        return {
          decision: "deny",
          reasonCodes: ["APPROVAL_REJECTED"],
          policyVersionId: evaluation.matchedPolicyVersionId,
          matchedRuleIndex: evaluation.matchedRuleIndex,
          approvalId: approvedByOverride.approvalId,
          approvalStatus: "rejected",
          limits: emptyLimits,
        };
      }

      if (approvedByOverride.approvalStatus === "pending") {
        return {
          decision: "require_approval",
          reasonCodes: evaluation.reasonCodes,
          policyVersionId: evaluation.matchedPolicyVersionId,
          matchedRuleIndex: evaluation.matchedRuleIndex,
          approvalId: approvedByOverride.approvalId,
          approvalStatus: "pending",
          limits: usagePreview.limits,
        };
      }

      const approval = await this.approvalService.create({
        organizationId: organization.id,
        sessionId: session.id,
        runId: run?.id ?? null,
        reasonCodes: evaluation.reasonCodes,
        toolName: tool.name,
        action: tool.action,
        resource: tool.resource,
        justification: String(policyContext.justification ?? ""),
        requestedByAgentId: agent.id,
      });

      return {
        decision: "require_approval",
        reasonCodes: evaluation.reasonCodes,
        policyVersionId: evaluation.matchedPolicyVersionId,
        matchedRuleIndex: evaluation.matchedRuleIndex,
        approvalId: approval.id,
        approvalStatus: approval.status,
        limits: usagePreview.limits,
      };
    }

    const usageCheck = await this.usageService.checkUsage({
      organizationId: organization.id,
      toolName: tool.name,
      estimatedCostUsd,
      tokenCount,
      reserve: true,
    });

    if (!usageCheck.allowed) {
      await this.logToolDecision("tool.denied", organization.id, session.id, run?.id ?? null, agent.id, {
        reasonCodes: usageCheck.reasonCodes,
        toolName: input.tool.name,
      });

      return {
        decision: "deny",
        reasonCodes: usageCheck.reasonCodes,
        policyVersionId: evaluation.matchedPolicyVersionId,
        matchedRuleIndex: evaluation.matchedRuleIndex,
        approvalId: approvedByOverride.approvalId,
        approvalStatus: approvedByOverride.approvalStatus,
        limits: usageCheck.limits,
      };
    }

    await this.logToolDecision("tool.authorized", organization.id, session.id, run?.id ?? null, agent.id, {
      toolName: input.tool.name,
      approvalId: approvedByOverride.approvalId,
      approvalStatus: approvedByOverride.approvalStatus,
      limits: usageCheck.limits,
    });

    return {
      decision: "allow",
      reasonCodes: evaluation.reasonCodes,
      policyVersionId: evaluation.matchedPolicyVersionId,
      matchedRuleIndex: evaluation.matchedRuleIndex,
      approvalId: approvedByOverride.approvalId,
      approvalStatus: approvedByOverride.approvalStatus,
      limits: usageCheck.limits,
    };
  }

  private async handleApprovalOverride(
    input: {
      approvalId: string | null;
      organizationId: string;
      sessionId: string;
      toolName: string;
      action: string;
      resource: string;
    },
  ): Promise<{ approved: boolean; approvalId: string | null; approvalStatus: ApprovalStatus | null }> {
    if (!input.approvalId) {
      return { approved: false, approvalId: null, approvalStatus: null };
    }

    const approval = await this.approvalService.validateApprovalBinding({
      approvalId: input.approvalId,
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      action: input.action,
      resource: input.resource,
    });

    if (approval.status === "approved") {
      await this.approvalService.validateApprovedApproval({
        approvalId: approval.id,
        organizationId: input.organizationId,
        sessionId: input.sessionId,
        toolName: input.toolName,
        action: input.action,
        resource: input.resource,
      });

      return {
        approved: true,
        approvalId: approval.id,
        approvalStatus: "approved",
      };
    }

    if (approval.status === "pending") {
      return { approved: false, approvalId: approval.id, approvalStatus: "pending" };
    }

    if (approval.status === "rejected") {
      return { approved: false, approvalId: approval.id, approvalStatus: "rejected" };
    }

    return { approved: false, approvalId: approval.id, approvalStatus: "expired" };
  }

  private async resolveContext(input: AuthorizeToolInput): Promise<ResolvedAuthorizeContext> {
    const organization = await this.store.getOrganization(input.orgId);
    const session = await this.store.getSession(input.sessionId);
    const agent = await this.store.getAgent(input.agentId);
    const run = input.runId ? await this.store.getRun(input.runId) : null;
    const tool = await this.store.findToolByName(input.orgId, input.tool.name);

    if (!organization) {
      throw notFound("Organization", { orgId: input.orgId });
    }
    if (!session) {
      throw notFound("Session", { sessionId: input.sessionId });
    }
    if (!agent) {
      throw notFound("Agent", { agentId: input.agentId });
    }
    if (input.runId && !run) {
      throw notFound("Run", { runId: input.runId });
    }
    if (!tool) {
      throw notFound("Tool", { toolName: input.tool.name });
    }

    assertApp(session.organizationId === organization.id, "Session organization mismatch", 409, "SESSION_ORG_MISMATCH");
    assertApp(session.agentId === agent.id, "Session agent mismatch", 409, "SESSION_AGENT_MISMATCH");
    assertApp(agent.organizationId === organization.id, "Agent organization mismatch", 409, "AGENT_ORG_MISMATCH");
    assertApp(tool.organizationId === organization.id, "Tool organization mismatch", 409, "TOOL_ORG_MISMATCH");

    if (run) {
      assertApp(run.organizationId === organization.id, "Run organization mismatch", 409, "RUN_ORG_MISMATCH");
      assertApp(run.sessionId === session.id, "Run session mismatch", 409, "RUN_SESSION_MISMATCH");
    }

    if (input.tool.action !== undefined) {
      assertApp(input.tool.action === tool.action, "Tool action mismatch", 409, "TOOL_ACTION_MISMATCH");
    }
    if (input.tool.resource !== undefined) {
      assertApp(input.tool.resource === tool.resource, "Tool resource mismatch", 409, "TOOL_RESOURCE_MISMATCH");
    }
    if (input.tool.riskLevel !== undefined) {
      assertApp(input.tool.riskLevel === tool.riskLevel, "Tool risk level mismatch", 409, "TOOL_RISK_LEVEL_MISMATCH");
    }

    const requestedEnvironment = input.context.environment;
    if (requestedEnvironment !== undefined) {
      assertApp(
        String(requestedEnvironment) === session.environment,
        "Context environment mismatch",
        409,
        "ENVIRONMENT_MISMATCH",
      );
    }

    return {
      organization,
      session,
      agent,
      run,
      tool,
      estimatedCostUsd: tool.estimatedCostUsd,
      tokenCount: input.tokenCount ?? 0,
      policyContext: {
        ...input.context,
        environment: session.environment,
      },
    };
  }

  private getRequiredScopes(tool: Tool): string[] {
    const provider = tool.name.split(".")[0] ?? tool.name;
    const aliasMap: Record<string, string[]> = {
      post: ["write"],
      create: ["write"],
      update: ["write"],
      send: ["write"],
      execute: ["exec"],
      export: ["read"],
    };

    return Array.from(
      new Set([tool.action, ...(aliasMap[tool.action] ?? [])].map((action) => `${provider}:${action}`)),
    );
  }

  private hasScope(scopes: string[], requiredScopes: string[]): boolean {
    if (scopes.includes("*") || requiredScopes.some((requiredScope) => scopes.includes(requiredScope))) {
      return true;
    }

    const providers = new Set(requiredScopes.map((requiredScope) => requiredScope.split(":")[0]));
    return [...providers].some((provider) => scopes.includes(`${provider}:*`));
  }

  private async logToolDecision(
    eventType: "tool.authorized" | "tool.denied",
    organizationId: string,
    sessionId: string,
    runId: string | null,
    actorId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.auditService.log({
      organizationId,
      sessionId,
      runId,
      eventType,
      actorType: "agent",
      actorId,
      payload,
    });
  }
}
