import "dotenv/config";
import { randomUUID } from "node:crypto";
import { demoAgent, demoPolicyCatalog, demoToolCatalog, demoToolNames } from "../src/demo/demo-catalog";

type Decision = "allow" | "deny" | "require_approval";

type ApiOptions = {
  method?: "GET" | "POST";
  apiKey?: string;
  body?: unknown;
};

function getBaseUrl(): string {
  return (process.env.TOOLGUARD_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

async function waitForHealth(baseUrl: string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        const payload = (await response.json()) as { status?: string };
        if (payload.status === "ok") {
          return;
        }
      }
    } catch {
      // Ignore connection errors while the stack is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`Timed out waiting for ToolGuard health at ${baseUrl}/healthz`);
}

async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (options.apiKey) {
    headers.authorization = `Bearer ${options.apiKey}`;
  }

  const response = await fetch(`${getBaseUrl()}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`Request failed ${response.status} ${path}: ${JSON.stringify(payload)}`);
  }

  return payload as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertDecision(payload: { decision?: string }, expected: Decision, context: string): void {
  assert(payload.decision === expected, `${context} decision mismatch: expected ${expected}, received ${payload.decision}`);
}

async function main(): Promise<void> {
  const baseUrl = getBaseUrl();
  await waitForHealth(baseUrl);

  const suffix = randomUUID().slice(0, 8);
  const organizationName = `ToolGuard Acceptance ${suffix}`;

  const bootstrap = await apiRequest<{
    organization: { id: string };
    rawApiKey: string;
  }>("/v1/organizations", {
    body: {
      name: organizationName,
      apiKeyName: "Acceptance key",
    },
  });

  const orgId = bootstrap.organization.id;
  const apiKey = bootstrap.rawApiKey;

  const agent = await apiRequest<{ id: string }>("/v1/agents", {
    apiKey,
    body: {
      orgId,
      name: `${demoAgent.name}-${suffix}`,
      description: demoAgent.description,
      environment: demoAgent.environment,
      defaultScopes: [...demoAgent.defaultScopes],
    },
  });

  await Promise.all(
    demoToolCatalog.map((tool) =>
      apiRequest("/v1/tools", {
        apiKey,
        body: {
          orgId,
          name: tool.name,
          action: tool.action,
          resource: tool.resource,
          description: tool.description,
          riskLevel: tool.riskLevel,
        },
      }),
    ),
  );

  await Promise.all(
    demoPolicyCatalog.map((policy) =>
      apiRequest("/v1/policies", {
        apiKey,
        body: {
          orgId,
          name: policy.name,
          description: policy.description,
          isActive: true,
          rulesJson: policy.rulesJson,
        },
      }),
    ),
  );

  const session = await apiRequest<{ id: string }>("/v1/sessions", {
    apiKey,
    body: {
      orgId,
      agentId: agent.id,
      userId: "acceptance-user",
      servicePrincipal: null,
      environment: "production",
      scopes: [...demoAgent.defaultScopes],
      metadata: {
        source: "live-acceptance",
      },
    },
  });

  const run = await apiRequest<{ id: string }>("/v1/runs", {
    apiKey,
    body: {
      orgId,
      sessionId: session.id,
      promptSummary: "Acceptance flow for ToolGuard",
      metadata: {
        source: "ci",
      },
    },
  });

  const slackDecision = await apiRequest<{
    decision: Decision;
    reasonCodes: string[];
  }>("/v1/tool/authorize", {
    apiKey,
    body: {
      orgId,
      agentId: agent.id,
      sessionId: session.id,
      runId: run.id,
      tool: {
        name: demoToolNames.slack,
      },
      context: {
        justification: "Internal case update",
      },
      payloadSummary: {
        channelType: "internal",
      },
      tokenCount: 25,
    },
  });
  assertDecision(slackDecision, "allow", "Slack internal post");

  const gmailDecision = await apiRequest<{
    decision: Decision;
    approvalId: string | null;
    approvalStatus: string | null;
  }>("/v1/tool/authorize", {
    apiKey,
    body: {
      orgId,
      agentId: agent.id,
      sessionId: session.id,
      runId: run.id,
      tool: {
        name: demoToolNames.gmail,
      },
      context: {
        justification: "Send refund update to customer",
        sensitivity: "customer_data",
      },
      payloadSummary: {
        recipientDomain: "gmail.com",
        containsAttachment: false,
      },
      tokenCount: 120,
    },
  });
  assertDecision(gmailDecision, "require_approval", "External Gmail send");
  assert(gmailDecision.approvalId, "Gmail authorization did not return an approvalId");
  assert(gmailDecision.approvalStatus === "pending", "Gmail approval was not left pending");

  const approval = await apiRequest<{ status: string }>(`/v1/approvals/${gmailDecision.approvalId}/resolve`, {
    apiKey,
    body: {
      status: "approved",
    },
  });
  assert(approval.status === "approved", `Approval resolve mismatch: expected approved, received ${approval.status}`);

  const gmailApprovedDecision = await apiRequest<{
    decision: Decision;
    approvalStatus: string | null;
  }>("/v1/tool/authorize", {
    apiKey,
    body: {
      orgId,
      agentId: agent.id,
      sessionId: session.id,
      runId: run.id,
      approvalId: gmailDecision.approvalId,
      tool: {
        name: demoToolNames.gmail,
      },
      context: {
        justification: "Send refund update to customer",
        sensitivity: "customer_data",
      },
      payloadSummary: {
        recipientDomain: "gmail.com",
        containsAttachment: false,
      },
      tokenCount: 120,
    },
  });
  assertDecision(gmailApprovedDecision, "allow", "Approved Gmail retry");
  assert(gmailApprovedDecision.approvalStatus === "approved", "Approved Gmail retry did not preserve approval status");

  const stripeDecision = await apiRequest<{
    decision: Decision;
    reasonCodes: string[];
  }>("/v1/tool/authorize", {
    apiKey,
    body: {
      orgId,
      agentId: agent.id,
      sessionId: session.id,
      runId: run.id,
      tool: {
        name: demoToolNames.stripeRefund,
      },
      context: {
        justification: "Refund a large payment",
      },
      payloadSummary: {
        amountUsd: 1500,
      },
      tokenCount: 80,
    },
  });
  assertDecision(stripeDecision, "deny", "Stripe refund over threshold");

  const completedRun = await apiRequest<{ status: string }>(`/v1/runs/${run.id}/complete`, {
    apiKey,
    body: {
      status: "completed",
    },
  });
  assert(completedRun.status === "completed", `Run completion mismatch: expected completed, received ${completedRun.status}`);

  const replay = await apiRequest<{
    items: Array<{ eventType: string }>;
  }>(`/v1/runs/${run.id}/replay`, {
    apiKey,
    method: "GET",
  });

  const replayEventTypes = replay.items.map((item) => item.eventType);
  const expectedReplaySequence = [
    "run.started",
    "tool.authorization.requested",
    "policy.evaluated",
    "tool.authorized",
    "tool.authorization.requested",
    "policy.evaluated",
    "approval.requested",
    "approval.resolved",
    "tool.authorization.requested",
    "policy.evaluated",
    "tool.authorized",
    "tool.authorization.requested",
    "policy.evaluated",
    "tool.denied",
    "run.completed",
  ];

  assert(
    replayEventTypes.length === expectedReplaySequence.length,
    `Replay length mismatch: expected ${expectedReplaySequence.length}, received ${replayEventTypes.length}`,
  );
  assert(
    JSON.stringify(replayEventTypes) === JSON.stringify(expectedReplaySequence),
    `Replay sequence mismatch: ${JSON.stringify(replayEventTypes)}`,
  );

  console.log(
    JSON.stringify(
      {
        organizationId: orgId,
        agentId: agent.id,
        sessionId: session.id,
        runId: run.id,
        approvalId: gmailDecision.approvalId,
        decisions: {
          slack: slackDecision.decision,
          gmailInitial: gmailDecision.decision,
          gmailApproved: gmailApprovedDecision.decision,
          stripe: stripeDecision.decision,
        },
        replayEventTypes,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Live acceptance failed");
  console.error(error);
  process.exit(1);
});
