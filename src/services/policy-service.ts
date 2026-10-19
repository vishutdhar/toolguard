import { getByPath } from "../lib/object-path";
import type { Decision, LatestPolicyVersion, PolicyCondition, PolicyRule } from "../domain/types";

const operatorKeys = ["equals", "in", "gt", "gte", "lt", "lte"] as const;
const decisionPriority: Record<Decision, number> = {
  allow: 1,
  require_approval: 2,
  deny: 3,
};

// Environments that are explicitly recognized as non-production. ANY other
// label (including "prod", "staging", "production" with different casing, or an
// unknown string) is treated as production so the safe-by-default posture never
// silently degrades to the permissive dev default (H1).
const DEV_ENVIRONMENTS = new Set(["development", "dev", "local", "test"]);

export function normalizeEnvironment(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

// A rule can definitively match, definitively not match, or be impossible to
// evaluate (e.g. a numeric operator against a non-numeric value). The last case
// must fail safe rather than silently skipping a protective rule (M2).
type RuleMatch = "match" | "no-match" | "indeterminate";

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

function evaluateRule(rule: PolicyRule, candidate: Record<string, unknown>): RuleMatch {
  let indeterminate = false;

  for (const [path, expected] of Object.entries(rule.if)) {
    const actual = getByPath(candidate, path);

    if (!isPolicyCondition(expected)) {
      if (!equalsValue(actual, expected)) {
        return "no-match";
      }
      continue;
    }

    if (expected.equals !== undefined && !equalsValue(actual, expected.equals)) {
      return "no-match";
    }

    if (expected.in !== undefined) {
      if (Array.isArray(actual)) {
        if (!actual.some((item) => expected.in?.some((allowed) => equalsValue(item, allowed)))) {
          return "no-match";
        }
      } else if (!expected.in.some((allowed) => equalsValue(actual, allowed))) {
        return "no-match";
      }
    }

    const hasNumericOperator =
      expected.gt !== undefined ||
      expected.gte !== undefined ||
      expected.lt !== undefined ||
      expected.lte !== undefined;

    if (hasNumericOperator) {
      const actualNumeric = numericValue(actual);
      if (actualNumeric === null) {
        // Cannot evaluate the comparison — mark indeterminate but keep checking
        // the remaining conditions, which may still definitively rule this out.
        indeterminate = true;
      } else {
        if (expected.gt !== undefined && actualNumeric <= expected.gt) return "no-match";
        if (expected.gte !== undefined && actualNumeric < expected.gte) return "no-match";
        if (expected.lt !== undefined && actualNumeric >= expected.lt) return "no-match";
        if (expected.lte !== undefined && actualNumeric > expected.lte) return "no-match";
      }
    }
  }

  return indeterminate ? "indeterminate" : "match";
}

export function matchRule(rule: PolicyRule, candidate: Record<string, unknown>): boolean {
  return evaluateRule(rule, candidate) === "match";
}

function normalizeCandidate(input: PolicyEvaluationRequest): Record<string, unknown> {
  const environment = normalizeEnvironment(input.context.environment ?? "development");

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
      const outcome = evaluateRule(rule, candidate);
      if (outcome === "no-match") {
        return;
      }

      if (outcome === "indeterminate") {
        // A rule that cannot be fully evaluated may only fire if it is
        // protective (deny / require_approval). An allow rule must never match
        // on unevaluable input, and a protective rule must never be skipped.
        if (rule.then.decision === "allow") {
          return;
        }

        matches.push({
          decision: rule.then.decision,
          policyVersionId: version.id,
          ruleIndex,
          reasonCodes: [...(rule.then.reasonCodes ?? []), "MALFORMED_NUMERIC_OPERAND"],
        });
        return;
      }

      matches.push({
        decision: rule.then.decision,
        policyVersionId: version.id,
        ruleIndex,
        reasonCodes: rule.then.reasonCodes ?? [],
      });
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
    return DEV_ENVIRONMENTS.has(normalizeEnvironment(environment))
      ? this.defaultDevDecision
      : this.defaultProdDecision;
  }

  evaluate(policies: LatestPolicyVersion[], input: PolicyEvaluationRequest): PolicyEvaluationResult {
    const environment = normalizeEnvironment(input.context.environment ?? "development");
    return evaluatePolicies(policies, input, this.getDefaultDecision(environment));
  }
}
