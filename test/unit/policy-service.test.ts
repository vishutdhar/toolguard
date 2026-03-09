import { describe, expect, it } from "vitest";
import { PolicyService, evaluatePolicies, matchRule } from "../../src/services/policy-service";
import type { LatestPolicyVersion } from "../../src/domain/types";

describe("policy-service", () => {
  it("matches equality and numeric operators", () => {
    const rule = {
      if: {
        "tool.name": "stripe.refund",
        "payloadSummary.amountUsd": {
          gt: 100,
          lte: 500,
        },
      },
      then: {
        decision: "deny" as const,
        reasonCodes: ["LIMITED"],
      },
    };

    expect(
      matchRule(rule, {
        tool: {
          name: "stripe.refund",
        },
        payloadSummary: {
          amountUsd: 250,
        },
      }),
    ).toBe(true);

    expect(
      matchRule(rule, {
        tool: {
          name: "stripe.refund",
        },
        payloadSummary: {
          amountUsd: 600,
        },
      }),
    ).toBe(false);
  });

  it("supports in operator against scalar values", () => {
    const rule = {
      if: {
        "payloadSummary.recipientDomain": {
          in: ["gmail.com", "yahoo.com"],
        },
      },
      then: {
        decision: "require_approval" as const,
      },
    };

    expect(
      matchRule(rule, {
        payloadSummary: {
          recipientDomain: "gmail.com",
        },
      }),
    ).toBe(true);
  });

  it("applies the highest priority decision across multiple policies", () => {
    const policies: LatestPolicyVersion[] = [
      {
        policy: {
          id: "policy_1",
          organizationId: "org_1",
          name: "Allow Slack",
          description: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        version: {
          id: "polv_1",
          policyId: "policy_1",
          versionNumber: 1,
          rulesJson: [
            {
              if: {
                "tool.name": "slack.post_message",
              },
              then: {
                decision: "allow",
                reasonCodes: ["INTERNAL_COLLABORATION"],
              },
            },
          ],
          createdAt: new Date(),
        },
      },
      {
        policy: {
          id: "policy_2",
          organizationId: "org_1",
          name: "Block Shell",
          description: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        version: {
          id: "polv_2",
          policyId: "policy_2",
          versionNumber: 1,
          rulesJson: [
            {
              if: {
                "tool.resource": "shell",
              },
              then: {
                decision: "deny",
                reasonCodes: ["SHELL_EXECUTION_BLOCKED"],
              },
            },
          ],
          createdAt: new Date(),
        },
      },
    ];

    const result = evaluatePolicies(
      policies,
      {
        orgId: "org_1",
        agentId: "agent_1",
        sessionId: "sess_1",
        tool: {
          name: "shell.exec",
          action: "execute",
          resource: "shell",
          riskLevel: "high",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
        },
        payloadSummary: {},
      },
      "allow",
    );

    expect(result.decision).toBe("deny");
    expect(result.reasonCodes).toContain("SHELL_EXECUTION_BLOCKED");
    expect(result.matchedPolicyVersionId).toBe("polv_2");
  });

  it("returns sane defaults by environment", () => {
    const policyService = new PolicyService("allow", "require_approval");

    expect(policyService.getDefaultDecision("development")).toBe("allow");
    expect(policyService.getDefaultDecision("production")).toBe("require_approval");
  });
});
