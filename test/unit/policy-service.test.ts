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

// H1: the safe-by-default posture must not depend on an exact "production" literal.
describe("policy-service fail-safe environment defaults (H1)", () => {
  const svc = new PolicyService("allow", "require_approval");

  it("applies the strict default to any environment that is not a known dev environment", () => {
    expect(svc.getDefaultDecision("prod")).toBe("require_approval");
    expect(svc.getDefaultDecision("Production")).toBe("require_approval");
    expect(svc.getDefaultDecision("production ")).toBe("require_approval");
    expect(svc.getDefaultDecision("staging")).toBe("require_approval");
    expect(svc.getDefaultDecision("prod-us")).toBe("require_approval");
    expect(svc.getDefaultDecision("live")).toBe("require_approval");
    expect(svc.getDefaultDecision("")).toBe("require_approval");
  });

  it("keeps recognized dev environments permissive", () => {
    expect(svc.getDefaultDecision("development")).toBe("allow");
    expect(svc.getDefaultDecision("dev")).toBe("allow");
    expect(svc.getDefaultDecision("local")).toBe("allow");
    expect(svc.getDefaultDecision("test")).toBe("allow");
    expect(svc.getDefaultDecision("Development")).toBe("allow");
  });

  it("matches production-keyed rules regardless of label case/whitespace", () => {
    const policies: LatestPolicyVersion[] = [
      {
        policy: {
          id: "p",
          organizationId: "o",
          name: "Shell denied in production",
          description: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        version: {
          id: "v",
          policyId: "p",
          versionNumber: 1,
          rulesJson: [
            {
              if: { environment: "production", "tool.resource": "shell" },
              then: { decision: "deny", reasonCodes: ["SHELL_BLOCKED"] },
            },
          ],
          createdAt: new Date(),
        },
      },
    ];

    const result = evaluatePolicies(
      policies,
      {
        orgId: "o",
        agentId: "a",
        sessionId: "s",
        tool: { name: "shell.exec", action: "execute", resource: "shell", riskLevel: "high", estimatedCostUsd: 0 },
        context: { environment: "Production" },
        payloadSummary: {},
      },
      "require_approval",
    );

    expect(result.decision).toBe("deny");
  });
});

// M2: numeric operators must not silently skip a protective rule when the
// compared value is not coercible to a number.
describe("policy-service numeric operator fail-safe (M2)", () => {
  function wrap(rule: { if: Record<string, unknown>; then: { decision: "allow" | "deny" | "require_approval"; reasonCodes?: string[] } }): LatestPolicyVersion {
    return {
      policy: { id: "p", organizationId: "o", name: "n", description: null, isActive: true, createdAt: new Date(), updatedAt: new Date() },
      version: { id: "v", policyId: "p", versionNumber: 1, rulesJson: [rule as never], createdAt: new Date() },
    };
  }

  function input(payloadSummary: Record<string, unknown>) {
    return {
      orgId: "o",
      agentId: "a",
      sessionId: "s",
      tool: { name: "stripe.refund", action: "refund", resource: "stripe", riskLevel: "high" as const, estimatedCostUsd: 0 },
      context: { environment: "production" },
      payloadSummary,
    };
  }

  const denyRule = { if: { "payloadSummary.amountUsd": { gt: 1000 } }, then: { decision: "deny" as const, reasonCodes: ["REFUND_LIMIT"] } };

  it("escalates a deny rule when the numeric operand is non-numeric", () => {
    expect(evaluatePolicies([wrap(denyRule)], input({ amountUsd: "5,000" }), "allow").decision).toBe("deny");
    expect(evaluatePolicies([wrap(denyRule)], input({ amountUsd: { amount: 5000 } }), "allow").decision).toBe("deny");
  });

  it("does NOT match an allow rule on an indeterminate operand", () => {
    const allowRule = { if: { "payloadSummary.amountUsd": { gt: 1000 } }, then: { decision: "allow" as const } };
    // allow rule cannot fire on garbage input -> falls through to the (strict) default
    expect(evaluatePolicies([wrap(allowRule)], input({ amountUsd: "abc" }), "deny").decision).toBe("deny");
  });

  it("still evaluates real numeric operands correctly", () => {
    expect(evaluatePolicies([wrap(denyRule)], input({ amountUsd: 1500 }), "allow").decision).toBe("deny");
    expect(evaluatePolicies([wrap(denyRule)], input({ amountUsd: 500 }), "allow").decision).toBe("allow");
    expect(evaluatePolicies([wrap(denyRule)], input({ amountUsd: "1500" }), "allow").decision).toBe("deny");
  });
});
