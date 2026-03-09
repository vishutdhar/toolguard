import type { FastifyInstance } from "fastify";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppEnv } from "../config/env";
import type { PolicyRule } from "../domain/types";
import type { AuthContext, AuthService } from "../services/auth-service";
import type { ApprovalService } from "../services/approval-service";
import type { AuditService } from "../services/audit-service";
import type { AuthorizationService } from "../services/authorization-service";
import type { PolicyService } from "../services/policy-service";
import type { ReplayService } from "../services/replay-service";
import type { RunService } from "../services/run-service";
import type { UsageService } from "../services/usage-service";
import type { DataStore } from "../domain/store";
import { AppError, assertApp, notFound } from "../lib/errors";
import {
  assertSelfSignupAllowed,
  decisionSchema,
  metadataSchema,
  requireOrgAccess,
  riskLevelSchema,
  stringArraySchema,
} from "./shared";
import {
  presentAgent,
  presentApiKey,
  presentApproval,
  presentAuditEvent,
  presentOrganization,
  presentPolicy,
  presentRun,
  presentSession,
  presentTool,
} from "./presenters";

type Services = {
  env: AppEnv;
  store: DataStore;
  authService: AuthService;
  policyService: PolicyService;
  usageService: UsageService;
  approvalService: ApprovalService;
  auditService: AuditService;
  runService: RunService;
  replayService: ReplayService;
  authorizationService: AuthorizationService;
  healthCheck: () => Promise<{
    status: "ok" | "degraded";
    storageMode: "memory" | "prisma";
    database: "ok" | "down" | "skipped";
    redis: "ok" | "down" | "skipped";
  }>;
};

const policyRuleSchema = z.object({
  if: z.record(z.string(), z.unknown()),
  then: z.object({
    decision: decisionSchema,
    reasonCodes: z.array(z.string()).optional(),
  }),
});

const toolInputSchema = z.object({
  name: z.string().min(1),
  action: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  riskLevel: riskLevelSchema.optional(),
  estimatedCostUsd: z.number().nonnegative().optional().default(0),
});

const decisionResponseSchema = z.object({
  decision: decisionSchema,
  reasonCodes: z.array(z.string()),
  policyVersionId: z.string().nullable(),
  matchedRuleIndex: z.number().int().nullable(),
  approvalId: z.string().nullable(),
  approvalStatus: z.enum(["pending", "approved", "rejected", "expired"]).nullable(),
  limits: z.object({
    remainingActionsToday: z.number(),
    remainingBudgetUsd: z.number(),
    remainingToolActionsToday: z.number(),
    remainingTokensToday: z.number(),
  }),
});

function toPolicyRules(rules: z.infer<typeof policyRuleSchema>[]): PolicyRule[] {
  return rules as unknown as PolicyRule[];
}

export async function registerRoutes(
  app: FastifyInstance,
  services: Services,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  const requireAuth = async (authorizationHeader: string | undefined): Promise<AuthContext> =>
    services.authService.authenticate(authorizationHeader);

  const resolveCanonicalToolContext = async (input: {
    orgId: string;
    agentId: string;
    sessionId: string;
    tool: z.infer<typeof toolInputSchema>;
    context: Record<string, unknown>;
  }) => {
    const session = await services.store.getSession(input.sessionId);
    const agent = await services.store.getAgent(input.agentId);
    const tool = await services.store.findToolByName(input.orgId, input.tool.name);

    assertApp(session, "Session not found", 404, "SESSION_NOT_FOUND");
    assertApp(session.organizationId === input.orgId, "Session organization mismatch", 409, "SESSION_ORG_MISMATCH");
    assertApp(agent, "Agent not found", 404, "AGENT_NOT_FOUND");
    assertApp(agent.organizationId === input.orgId, "Agent organization mismatch", 409, "AGENT_ORG_MISMATCH");
    assertApp(session.agentId === agent.id, "Session agent mismatch", 409, "SESSION_AGENT_MISMATCH");
    assertApp(tool, "Tool not found", 404, "TOOL_NOT_FOUND");
    assertApp(tool.organizationId === input.orgId, "Tool organization mismatch", 409, "TOOL_ORG_MISMATCH");

    if (input.tool.action !== undefined) {
      assertApp(input.tool.action === tool.action, "Tool action mismatch", 409, "TOOL_ACTION_MISMATCH");
    }
    if (input.tool.resource !== undefined) {
      assertApp(input.tool.resource === tool.resource, "Tool resource mismatch", 409, "TOOL_RESOURCE_MISMATCH");
    }
    if (input.tool.riskLevel !== undefined) {
      assertApp(input.tool.riskLevel === tool.riskLevel, "Tool risk level mismatch", 409, "TOOL_RISK_LEVEL_MISMATCH");
    }
    if (input.context.environment !== undefined) {
      assertApp(
        String(input.context.environment) === session.environment,
        "Context environment mismatch",
        409,
        "ENVIRONMENT_MISMATCH",
      );
    }

    return {
      session,
      agent,
      tool,
      context: {
        ...input.context,
        environment: session.environment,
      },
    };
  };

  const validateAuditTargets = async (organizationId: string, sessionId?: string | null, runId?: string | null) => {
    const session = sessionId ? await services.store.getSession(sessionId) : null;
    const run = runId ? await services.store.getRun(runId) : null;

    if (sessionId) {
      assertApp(session, "Session not found", 404, "SESSION_NOT_FOUND");
      assertApp(session.organizationId === organizationId, "Session organization mismatch", 409, "SESSION_ORG_MISMATCH");
    }

    if (runId) {
      assertApp(run, "Run not found", 404, "RUN_NOT_FOUND");
      assertApp(run.organizationId === organizationId, "Run organization mismatch", 409, "RUN_ORG_MISMATCH");
      if (session) {
        assertApp(run.sessionId === session.id, "Run session mismatch", 409, "RUN_SESSION_MISMATCH");
      }
    }

    return { session, run };
  };

  typedApp.get(
    "/healthz",
    {
      schema: {
        tags: ["System"],
        summary: "Health check",
        response: {
          200: z.object({
            status: z.enum(["ok", "degraded"]),
            service: z.literal("toolguard-api"),
            storageMode: z.enum(["memory", "prisma"]),
            dependencies: z.object({
              database: z.enum(["ok", "down", "skipped"]),
              redis: z.enum(["ok", "down", "skipped"]),
            }),
          }),
          503: z.object({
            status: z.enum(["ok", "degraded"]),
            service: z.literal("toolguard-api"),
            storageMode: z.enum(["memory", "prisma"]),
            dependencies: z.object({
              database: z.enum(["ok", "down", "skipped"]),
              redis: z.enum(["ok", "down", "skipped"]),
            }),
          }),
        },
      },
    },
    async (_request, reply) => {
      const health = await services.healthCheck();
      const payload = {
        status: health.status,
        service: "toolguard-api" as const,
        storageMode: health.storageMode,
        dependencies: {
          database: health.database,
          redis: health.redis,
        },
      };

      if (health.status === "degraded") {
        return reply.status(503).send(payload);
      }

      return payload;
    },
  );

  typedApp.post(
    "/v1/organizations",
    {
      schema: {
        tags: ["Organizations"],
        summary: "Create an organization and bootstrap the first API key",
        body: z.object({
          name: z.string().min(1),
          apiKeyName: z.string().min(1).default("Default key"),
        }),
        response: {
          201: z.object({
            organization: z.record(z.string(), z.unknown()),
            apiKey: z.record(z.string(), z.unknown()),
            rawApiKey: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      assertSelfSignupAllowed(services.env.ALLOW_SELF_SIGNUP);
      const organization = await services.store.createOrganization({ name: request.body.name });
      const { apiKey, rawKey } = await services.authService.createApiKey(organization.id, request.body.apiKeyName);

      return reply.status(201).send({
        organization: presentOrganization(organization),
        apiKey: presentApiKey(apiKey),
        rawApiKey: rawKey,
      });
    },
  );

  typedApp.post(
    "/v1/api-keys",
    {
      schema: {
        tags: ["Organizations"],
        security: [{ bearerAuth: [] }],
        summary: "Create an additional API key",
        body: z.object({
          orgId: z.string().min(1),
          name: z.string().min(1),
        }),
        response: {
          201: z.object({
            apiKey: z.record(z.string(), z.unknown()),
            rawApiKey: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = await requireAuth(request.headers.authorization);
      requireOrgAccess(auth, request.body.orgId);
      const { apiKey, rawKey } = await services.authService.createApiKey(auth.organization.id, request.body.name);

      return reply.status(201).send({
        apiKey: presentApiKey(apiKey),
        rawApiKey: rawKey,
      });
    },
  );

  typedApp.post(
    "/v1/agents",
    {
      schema: {
        tags: ["Agents"],
        security: [{ bearerAuth: [] }],
        summary: "Create an agent",
        body: z.object({
          orgId: z.string().min(1),
          name: z.string().min(1),
          description: z.string().optional(),
          environment: z.string().min(1),
          defaultScopes: stringArraySchema,
        }),
        response: {
          201: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request, reply) => {
      const auth = await requireAuth(request.headers.authorization);
      requireOrgAccess(auth, request.body.orgId);
      const agent = await services.store.createAgent({
        organizationId: auth.organization.id,
        name: request.body.name,
        description: request.body.description ?? null,
        environment: request.body.environment,
        defaultScopes: request.body.defaultScopes,
      });

      return reply.status(201).send(presentAgent(agent));
    },
  );

  typedApp.get(
    "/v1/agents",
    {
      schema: {
        tags: ["Agents"],
        security: [{ bearerAuth: [] }],
        summary: "List agents for the authenticated organization",
        response: {
          200: z.object({
            items: z.array(z.record(z.string(), z.unknown())),
          }),
        },
      },
    },
    async (request) => {
      const auth = await requireAuth(request.headers.authorization);
      const items = await services.store.listAgents(auth.organization.id);
      return {
        items: items.map(presentAgent),
      };
    },
  );

  typedApp.post(
    "/v1/sessions",
    {
      schema: {
        tags: ["Sessions"],
        security: [{ bearerAuth: [] }],
        summary: "Create an agent session",
        body: z.object({
          orgId: z.string().min(1),
          agentId: z.string().min(1),
          userId: z.string().optional().nullable(),
          servicePrincipal: z.string().optional().nullable(),
          environment: z.string().min(1),
          scopes: stringArraySchema,
          metadata: metadataSchema,
        }),
        response: {
          201: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request, reply) => {
      const auth = await requireAuth(request.headers.authorization);
      requireOrgAccess(auth, request.body.orgId);
      const agent = await services.store.getAgent(request.body.agentId);
      assertApp(agent && agent.organizationId === auth.organization.id, "Agent not found in organization", 404, "AGENT_NOT_FOUND");
      const session = await services.store.createSession({
        organizationId: auth.organization.id,
        agentId: request.body.agentId,
        userId: request.body.userId ?? null,
        servicePrincipal: request.body.servicePrincipal ?? null,
        environment: request.body.environment,
        scopes: request.body.scopes,
        metadata: request.body.metadata,
      });

      return reply.status(201).send(presentSession(session));
    },
  );

  typedApp.post(
    "/v1/tools",
    {
      schema: {
        tags: ["Tools"],
        security: [{ bearerAuth: [] }],
        summary: "Create a tool definition",
        body: z.object({
          orgId: z.string().min(1),
          name: z.string().min(1),
          action: z.string().min(1),
          resource: z.string().min(1),
          description: z.string().optional(),
          riskLevel: riskLevelSchema,
        }),
        response: {
          201: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request, reply) => {
      const auth = await requireAuth(request.headers.authorization);
      requireOrgAccess(auth, request.body.orgId);
      const tool = await services.store.createTool({
        organizationId: auth.organization.id,
        name: request.body.name,
        action: request.body.action,
        resource: request.body.resource,
        description: request.body.description ?? null,
        riskLevel: request.body.riskLevel,
      });

      return reply.status(201).send(presentTool(tool));
    },
  );

  typedApp.get(
    "/v1/tools",
    {
      schema: {
        tags: ["Tools"],
        security: [{ bearerAuth: [] }],
        summary: "List tools for the authenticated organization",
        response: {
          200: z.object({
            items: z.array(z.record(z.string(), z.unknown())),
          }),
        },
      },
    },
    async (request) => {
      const auth = await requireAuth(request.headers.authorization);
      const tools = await services.store.listTools(auth.organization.id);
      return {
        items: tools.map(presentTool),
      };
    },
  );

  typedApp.post(
    "/v1/policies",
    {
      schema: {
        tags: ["Policies"],
        security: [{ bearerAuth: [] }],
        summary: "Create a policy and optionally its first version",
        body: z.object({
          orgId: z.string().min(1),
          name: z.string().min(1),
          description: z.string().optional(),
          isActive: z.boolean().optional().default(true),
          rulesJson: z.array(policyRuleSchema).optional(),
        }),
        response: {
          201: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request, reply) => {
      const auth = await requireAuth(request.headers.authorization);
      requireOrgAccess(auth, request.body.orgId);
      const policy = await services.store.createPolicy({
        organizationId: auth.organization.id,
        name: request.body.name,
        description: request.body.description ?? null,
        isActive: request.body.isActive,
      });

      if (request.body.rulesJson && request.body.rulesJson.length > 0) {
        await services.store.createPolicyVersion({
          policyId: policy.id,
          versionNumber: 1,
          rulesJson: toPolicyRules(request.body.rulesJson),
        });
      }

      const storedPolicy = await services.store.getPolicy(policy.id);
      if (!storedPolicy) {
        throw notFound("Policy", { policyId: policy.id });
      }

      return reply.status(201).send(presentPolicy(storedPolicy, storedPolicy.versions));
    },
  );

  typedApp.get(
    "/v1/policies/:policyId",
    {
      schema: {
        tags: ["Policies"],
        security: [{ bearerAuth: [] }],
        summary: "Get a policy with all versions",
        params: z.object({
          policyId: z.string().min(1),
        }),
        response: {
          200: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request) => {
      const auth = await requireAuth(request.headers.authorization);
      const policy = await services.store.getPolicy(request.params.policyId);
      assertApp(policy && policy.organizationId === auth.organization.id, "Policy not found", 404, "POLICY_NOT_FOUND");
      return presentPolicy(policy, policy.versions);
    },
  );

  typedApp.post(
    "/v1/policies/:policyId/versions",
    {
      schema: {
        tags: ["Policies"],
        security: [{ bearerAuth: [] }],
        summary: "Create a new policy version",
        params: z.object({
          policyId: z.string().min(1),
        }),
        body: z.object({
          rulesJson: z.array(policyRuleSchema).min(1),
        }),
        response: {
          201: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request, reply) => {
      const auth = await requireAuth(request.headers.authorization);
      const policy = await services.store.getPolicy(request.params.policyId);
      assertApp(policy && policy.organizationId === auth.organization.id, "Policy not found", 404, "POLICY_NOT_FOUND");
      const nextVersion = policy.versions.length + 1;
      const version = await services.store.createPolicyVersion({
        policyId: policy.id,
        versionNumber: nextVersion,
        rulesJson: toPolicyRules(request.body.rulesJson),
      });

      return reply.status(201).send({
        id: version.id,
        policyId: version.policyId,
        versionNumber: version.versionNumber,
        rulesJson: version.rulesJson,
        createdAt: version.createdAt.toISOString(),
      });
    },
  );

  typedApp.post(
    "/v1/policy/evaluate",
    {
      schema: {
        tags: ["Policy"],
        security: [{ bearerAuth: [] }],
        summary: "Evaluate policy rules without authorizing execution",
        body: z.object({
          orgId: z.string().min(1),
          agentId: z.string().min(1),
          sessionId: z.string().min(1),
          tool: toolInputSchema,
          context: metadataSchema,
          payloadSummary: metadataSchema,
        }),
        response: {
          200: z.object({
            decision: decisionSchema,
            reasonCodes: z.array(z.string()),
            policyVersionId: z.string().nullable(),
            matchedRuleIndex: z.number().int().nullable(),
            limits: z.object({
              remainingActionsToday: z.number(),
              remainingBudgetUsd: z.number(),
              remainingToolActionsToday: z.number(),
              remainingTokensToday: z.number(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const auth = await requireAuth(request.headers.authorization);
      requireOrgAccess(auth, request.body.orgId);
      const resolved = await resolveCanonicalToolContext({
        orgId: auth.organization.id,
        agentId: request.body.agentId,
        sessionId: request.body.sessionId,
        tool: request.body.tool,
        context: request.body.context,
      });

      const evaluation = services.policyService.evaluate(
        await services.store.listLatestActivePolicyVersions(auth.organization.id),
        {
          orgId: request.body.orgId,
          agentId: request.body.agentId,
          sessionId: request.body.sessionId,
          tool: {
            name: resolved.tool.name,
            action: resolved.tool.action,
            resource: resolved.tool.resource,
            riskLevel: resolved.tool.riskLevel,
            estimatedCostUsd: request.body.tool.estimatedCostUsd ?? 0,
          },
          context: resolved.context,
          payloadSummary: request.body.payloadSummary,
        },
      );

      const usage = await services.usageService.checkUsage({
        organizationId: auth.organization.id,
        toolName: resolved.tool.name,
        estimatedCostUsd: request.body.tool.estimatedCostUsd ?? 0,
        tokenCount: 0,
        reserve: false,
      });

      return {
        decision: evaluation.decision,
        reasonCodes: evaluation.reasonCodes,
        policyVersionId: evaluation.matchedPolicyVersionId,
        matchedRuleIndex: evaluation.matchedRuleIndex,
        limits: usage.limits,
      };
    },
  );

  typedApp.post(
    "/v1/usage/check",
    {
      schema: {
        tags: ["Usage"],
        security: [{ bearerAuth: [] }],
        summary: "Check or reserve usage capacity",
        body: z.object({
          orgId: z.string().min(1),
          toolName: z.string().min(1),
          estimatedCostUsd: z.number().nonnegative().default(0),
          tokenCount: z.number().int().nonnegative().default(0),
          reserve: z.boolean().default(false),
        }),
        response: {
          200: z.object({
            allowed: z.boolean(),
            reasonCodes: z.array(z.string()),
            windowKey: z.string(),
            limits: z.object({
              remainingActionsToday: z.number(),
              remainingBudgetUsd: z.number(),
              remainingToolActionsToday: z.number(),
              remainingTokensToday: z.number(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const auth = await requireAuth(request.headers.authorization);
      requireOrgAccess(auth, request.body.orgId);
      return services.usageService.checkUsage({
        organizationId: auth.organization.id,
        toolName: request.body.toolName,
        estimatedCostUsd: request.body.estimatedCostUsd,
        tokenCount: request.body.tokenCount,
        reserve: request.body.reserve,
      });
    },
  );

  typedApp.post(
    "/v1/tool/authorize",
    {
      schema: {
        tags: ["Authorization"],
        security: [{ bearerAuth: [] }],
        summary: "Authorize a tool call",
        body: z.object({
          orgId: z.string().min(1),
          agentId: z.string().min(1),
          sessionId: z.string().min(1),
          runId: z.string().optional().nullable(),
          approvalId: z.string().optional().nullable(),
          tool: toolInputSchema,
          context: metadataSchema,
          payloadSummary: metadataSchema,
          tokenCount: z.number().int().nonnegative().optional().default(0),
        }),
        response: {
          200: decisionResponseSchema,
        },
      },
    },
    async (request) => {
      const auth = await requireAuth(request.headers.authorization);
      requireOrgAccess(auth, request.body.orgId);
      return services.authorizationService.authorize({
        orgId: request.body.orgId,
        agentId: request.body.agentId,
        sessionId: request.body.sessionId,
        runId: request.body.runId ?? null,
        approvalId: request.body.approvalId ?? null,
        tool: request.body.tool,
        context: request.body.context,
        payloadSummary: request.body.payloadSummary,
        tokenCount: request.body.tokenCount,
      });
    },
  );

  typedApp.post(
    "/v1/approvals/request",
    {
      schema: {
        tags: ["Approvals"],
        security: [{ bearerAuth: [] }],
        summary: "Manually create an approval request",
        body: z.object({
          orgId: z.string().min(1),
          sessionId: z.string().min(1),
          runId: z.string().optional().nullable(),
          reasonCodes: z.array(z.string()).min(1),
          toolName: z.string().min(1),
          action: z.string().min(1),
          resource: z.string().min(1),
          justification: z.string().optional().nullable(),
          requestedByAgentId: z.string().min(1),
        }),
        response: {
          201: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request, reply) => {
      const auth = await requireAuth(request.headers.authorization);
      requireOrgAccess(auth, request.body.orgId);
      const approval = await services.approvalService.create({
        organizationId: auth.organization.id,
        sessionId: request.body.sessionId,
        runId: request.body.runId ?? null,
        reasonCodes: request.body.reasonCodes,
        toolName: request.body.toolName,
        action: request.body.action,
        resource: request.body.resource,
        justification: request.body.justification ?? null,
        requestedByAgentId: request.body.requestedByAgentId,
      });

      return reply.status(201).send(presentApproval(approval));
    },
  );

  typedApp.get(
    "/v1/approvals/:approvalId",
    {
      schema: {
        tags: ["Approvals"],
        security: [{ bearerAuth: [] }],
        summary: "Get an approval request",
        params: z.object({
          approvalId: z.string().min(1),
        }),
        response: {
          200: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request) => {
      const auth = await requireAuth(request.headers.authorization);
      const approval = await services.approvalService.get(request.params.approvalId);
      requireOrgAccess(auth, approval.organizationId);
      return presentApproval(approval);
    },
  );

  typedApp.post(
    "/v1/approvals/:approvalId/resolve",
    {
      schema: {
        tags: ["Approvals"],
        security: [{ bearerAuth: [] }],
        summary: "Resolve an approval request",
        params: z.object({
          approvalId: z.string().min(1),
        }),
        body: z.object({
          status: z.enum(["approved", "rejected"]),
        }),
        response: {
          200: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request) => {
      const auth = await requireAuth(request.headers.authorization);
      const approval = await services.approvalService.get(request.params.approvalId);
      requireOrgAccess(auth, approval.organizationId);
      const resolvedBy = `api_key:${auth.apiKey.keyPrefix}`;
      const resolved = await services.approvalService.resolve(
        request.params.approvalId,
        request.body.status,
        resolvedBy,
      );

      return presentApproval(resolved);
    },
  );

  typedApp.post(
    "/v1/audit/events",
    {
      schema: {
        tags: ["Audit"],
        security: [{ bearerAuth: [] }],
        summary: "Ingest an explicit audit event",
        body: z.object({
          orgId: z.string().min(1),
          sessionId: z.string().optional().nullable(),
          runId: z.string().optional().nullable(),
          eventType: z.string().min(1),
          actorType: z.string().min(1),
          actorId: z.string().optional().nullable(),
          payload: metadataSchema,
        }),
        response: {
          201: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request, reply) => {
      const auth = await requireAuth(request.headers.authorization);
      requireOrgAccess(auth, request.body.orgId);
      await validateAuditTargets(auth.organization.id, request.body.sessionId ?? null, request.body.runId ?? null);
      const event = await services.auditService.log({
        organizationId: auth.organization.id,
        sessionId: request.body.sessionId ?? null,
        runId: request.body.runId ?? null,
        eventType: request.body.eventType,
        actorType: request.body.actorType,
        actorId: request.body.actorId ?? null,
        payload: request.body.payload,
      });

      return reply.status(201).send(presentAuditEvent(event));
    },
  );

  typedApp.post(
    "/v1/runs",
    {
      schema: {
        tags: ["Runs"],
        security: [{ bearerAuth: [] }],
        summary: "Create a run",
        body: z.object({
          orgId: z.string().min(1),
          sessionId: z.string().min(1),
          promptSummary: z.string().optional().nullable(),
          metadata: metadataSchema,
        }),
        response: {
          201: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request, reply) => {
      const auth = await requireAuth(request.headers.authorization);
      requireOrgAccess(auth, request.body.orgId);
      const session = await services.store.getSession(request.body.sessionId);
      assertApp(session && session.organizationId === auth.organization.id, "Session not found", 404, "SESSION_NOT_FOUND");
      const run = await services.runService.create({
        organizationId: auth.organization.id,
        sessionId: request.body.sessionId,
        promptSummary: request.body.promptSummary ?? null,
        metadata: request.body.metadata,
      });

      return reply.status(201).send(presentRun(run));
    },
  );

  typedApp.post(
    "/v1/runs/:runId/complete",
    {
      schema: {
        tags: ["Runs"],
        security: [{ bearerAuth: [] }],
        summary: "Mark a run completed or failed",
        params: z.object({
          runId: z.string().min(1),
        }),
        body: z.object({
          status: z.enum(["completed", "failed"]),
        }),
        response: {
          200: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request) => {
      const auth = await requireAuth(request.headers.authorization);
      const run = await services.store.getRun(request.params.runId);
      assertApp(run && run.organizationId === auth.organization.id, "Run not found", 404, "RUN_NOT_FOUND");
      const updatedRun = await services.runService.complete(request.params.runId, request.body.status);
      return presentRun(updatedRun);
    },
  );

  typedApp.get(
    "/v1/runs/:runId/replay",
    {
      schema: {
        tags: ["Runs"],
        security: [{ bearerAuth: [] }],
        summary: "Get an ordered replay timeline for a run",
        params: z.object({
          runId: z.string().min(1),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                timestamp: z.string(),
                eventType: z.string(),
                summary: z.string(),
                payload: z.record(z.string(), z.unknown()),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = await requireAuth(request.headers.authorization);
      const run = await services.store.getRun(request.params.runId);
      assertApp(run && run.organizationId === auth.organization.id, "Run not found", 404, "RUN_NOT_FOUND");
      return {
        items: await services.replayService.replay(request.params.runId),
      };
    },
  );
}
