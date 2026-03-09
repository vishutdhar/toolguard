import { getByPath } from "../lib/object-path";
import type { Decision, LatestPolicyVersion, PolicyCondition, PolicyRule } from "../domain/types";

const operatorKeys = ["equals", "in", "gt", "gte", "lt", "lte"] as const;
const decisionPriority: Record<Decision, number> = {
  allow: 1,
  require_approval: 2,
  deny: 3,
};

export interface PolicyEvaluationRequest {
  orgId: string;
  agentId: string;
  sessionId: string;
  tool: {
    name: string;
    action: string;
    resource: string;
    riskLevel: "low" | "medium" | "high";
    estimatedCostUsd?: number;
  };
  context: Record<string, unknown>;
  payloadSummary: Record<string, unknown>;
}

export interface PolicyEvaluationResult {
  decision: Decision;
  matchedPolicyVersionId: string | null;
  matchedRuleIndex: number | null;
  reasonCodes: string[];
}

function isPolicyCondition(value: unknown): value is PolicyCondition {
  return Boolean(
    value &&
      typeof value === "object" &&
      operatorKeys.some((key) => Object.prototype.hasOwnProperty.call(value, key)),
  );
}

function equalsValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right) || typeof left === "object" || typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  return left === right;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function matchRule(rule: PolicyRule, candidate: Record<string, unknown>): boolean {
  return Object.entries(rule.if).every(([path, expected]) => {
    const actual = getByPath(candidate, path);

    if (!isPolicyCondition(expected)) {
      return equalsValue(actual, expected);
    }

    if (expected.equals !== undefined && !equalsValue(actual, expected.equals)) {
      return false;
    }

    if (expected.in !== undefined) {
      if (Array.isArray(actual)) {
        if (!actual.some((item) => expected.in?.some((allowed) => equalsValue(item, allowed)))) {
          return false;
        }
      } else if (!expected.in.some((allowed) => equalsValue(actual, allowed))) {
        return false;
      }
    }

    const actualNumeric = numericValue(actual);
    if (expected.gt !== undefined && (actualNumeric === null || actualNumeric <= expected.gt)) {
      return false;
    }
    if (expected.gte !== undefined && (actualNumeric === null || actualNumeric < expected.gte)) {
      return false;
    }
    if (expected.lt !== undefined && (actualNumeric === null || actualNumeric >= expected.lt)) {
      return false;
    }
    if (expected.lte !== undefined && (actualNumeric === null || actualNumeric > expected.lte)) {
      return false;
    }

    return true;
  });
}

function normalizeCandidate(input: PolicyEvaluationRequest): Record<string, unknown> {
  const environment = String(input.context.environment ?? "development");

  return {
    orgId: input.orgId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    environment,
    tool: {
      ...input.tool,
      estimatedCostUsd: input.tool.estimatedCostUsd ?? 0,
    },
    context: input.context,
    payloadSummary: input.payloadSummary,
  };
}

export function evaluatePolicies(
  policies: LatestPolicyVersion[],
  input: PolicyEvaluationRequest,
  defaultDecision: Decision,
): PolicyEvaluationResult {
  const candidate = normalizeCandidate(input);
  const matches: Array<{
    decision: Decision;
    policyVersionId: string;
    ruleIndex: number;
    reasonCodes: string[];
  }> = [];

  policies.forEach(({ version }) => {
    version.rulesJson.forEach((rule, ruleIndex) => {
      if (matchRule(rule, candidate)) {
        matches.push({
          decision: rule.then.decision,
          policyVersionId: version.id,
          ruleIndex,
          reasonCodes: rule.then.reasonCodes ?? [],
        });
      }
    });
  });

  if (matches.length === 0) {
    return {
      decision: defaultDecision,
      matchedPolicyVersionId: null,
      matchedRuleIndex: null,
      reasonCodes:
        defaultDecision === "allow"
          ? ["DEFAULT_ALLOW"]
          : defaultDecision === "deny"
            ? ["DEFAULT_DENY"]
            : ["DEFAULT_REQUIRE_APPROVAL"],
    };
  }

  const highestPriority = Math.max(...matches.map((match) => decisionPriority[match.decision]));
  const winners = matches.filter((match) => decisionPriority[match.decision] === highestPriority);
  const firstWinner = winners[0];

  return {
    decision: firstWinner.decision,
    matchedPolicyVersionId: firstWinner.policyVersionId,
    matchedRuleIndex: firstWinner.ruleIndex,
    reasonCodes: [...new Set(winners.flatMap((winner) => winner.reasonCodes))],
  };
}

export class PolicyService {
  constructor(
    private readonly defaultDevDecision: Decision,
    private readonly defaultProdDecision: Decision,
  ) {}

  getDefaultDecision(environment: string): Decision {
    return environment === "production" ? this.defaultProdDecision : this.defaultDevDecision;
  }

  evaluate(policies: LatestPolicyVersion[], input: PolicyEvaluationRequest): PolicyEvaluationResult {
    const environment = String(input.context.environment ?? "development");
    return evaluatePolicies(policies, input, this.getDefaultDecision(environment));
  }
}
