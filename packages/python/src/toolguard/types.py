"""Response and input shapes for the ToolGuard API.

Responses are plain dicts with the API's camelCase keys. The TypedDicts below
describe them for type checkers; nothing is validated at runtime.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

if sys.version_info >= (3, 11):
    from typing import Literal, NotRequired, TypedDict
else:  # pragma: no cover
    from typing_extensions import Literal, NotRequired, TypedDict

Decision = Literal["allow", "deny", "require_approval"]
RiskLevel = Literal["low", "medium", "high"]
ApprovalStatus = Literal["pending", "approved", "rejected", "expired", "consumed"]
RunStatus = Literal["completed", "failed"]


class ToolInput(TypedDict):
    name: str
    action: NotRequired[str]
    resource: NotRequired[str]
    riskLevel: NotRequired[RiskLevel]


class PolicyRuleThen(TypedDict):
    decision: Decision
    reasonCodes: NotRequired[List[str]]


# "if" is a Python keyword, so PolicyRule uses the functional TypedDict form.
PolicyRule = TypedDict("PolicyRule", {"if": Dict[str, Any], "then": PolicyRuleThen})


class Limits(TypedDict):
    remainingActionsToday: float
    remainingBudgetUsd: float
    remainingToolActionsToday: float
    remainingTokensToday: float


class HealthCheck(TypedDict):
    status: Literal["ok", "degraded"]
    service: str
    storageMode: Literal["memory", "prisma"]
    dependencies: Dict[str, str]


class Organization(TypedDict, total=False):
    id: str
    name: str
    createdAt: str
    updatedAt: str


class ApiKey(TypedDict, total=False):
    id: str
    organizationId: str
    name: str
    keyPrefix: str
    lastUsedAt: Optional[str]
    createdAt: str
    revokedAt: Optional[str]


class BootstrapResult(TypedDict):
    organization: Organization
    apiKey: ApiKey
    rawApiKey: str


class ApiKeyResult(TypedDict):
    apiKey: ApiKey
    rawApiKey: str


class Agent(TypedDict, total=False):
    id: str
    organizationId: str
    name: str
    description: Optional[str]
    environment: str
    defaultScopes: List[str]
    createdAt: str
    updatedAt: str


class Session(TypedDict, total=False):
    id: str
    orgId: str
    agentId: str
    userId: Optional[str]
    servicePrincipal: Optional[str]
    environment: str
    scopes: List[str]
    metadata: Dict[str, Any]
    startedAt: str
    endedAt: Optional[str]


class Tool(TypedDict, total=False):
    id: str
    organizationId: str
    name: str
    action: str
    resource: str
    description: Optional[str]
    riskLevel: RiskLevel
    estimatedCostUsd: float
    createdAt: str
    updatedAt: str


class PolicyVersion(TypedDict, total=False):
    id: str
    policyId: str
    versionNumber: int
    rulesJson: List[PolicyRule]
    createdAt: str


class Policy(TypedDict, total=False):
    id: str
    organizationId: str
    name: str
    description: Optional[str]
    isActive: bool
    versions: List[PolicyVersion]
    createdAt: str
    updatedAt: str


class EvaluatePolicyResult(TypedDict):
    decision: Decision
    reasonCodes: List[str]
    policyVersionId: Optional[str]
    matchedRuleIndex: Optional[int]
    limits: Limits


class UsageCheckResult(TypedDict):
    allowed: bool
    reasonCodes: List[str]
    windowKey: str
    limits: Limits


class Approval(TypedDict, total=False):
    id: str
    organizationId: str
    sessionId: str
    runId: Optional[str]
    status: ApprovalStatus
    reasonCodes: List[str]
    toolName: str
    action: str
    resource: str
    justification: Optional[str]
    requestedByAgentId: str
    resolvedBy: Optional[str]
    resolvedAt: Optional[str]
    expiresAt: Optional[str]
    consumedAt: Optional[str]
    consumedByInvocationId: Optional[str]
    createdAt: str


class AuditEvent(TypedDict, total=False):
    id: str
    organizationId: str
    sessionId: Optional[str]
    runId: Optional[str]
    eventType: str
    actorType: str
    actorId: Optional[str]
    payload: Dict[str, Any]
    createdAt: str


class Run(TypedDict, total=False):
    id: str
    organizationId: str
    sessionId: str
    status: str
    promptSummary: Optional[str]
    metadata: Dict[str, Any]
    startedAt: str
    completedAt: Optional[str]


class ReplayItem(TypedDict):
    timestamp: str
    eventType: str
    payload: Dict[str, Any]


class WebhookConfig(TypedDict, total=False):
    id: str
    organizationId: str
    url: str
    eventTypes: List[str]
    secret: Optional[str]
    createdAt: str


class Page(TypedDict):
    """One page of a cursor-paginated list. Pass ``cursor`` back to get the next page."""

    items: List[Dict[str, Any]]
    cursor: Optional[str]


@dataclass(frozen=True)
class AuthorizationDecision:
    """The result of ``authorize()``.

    ``allowed``, ``denied`` and ``pending_approval`` mirror the TypeScript
    client's helpers. ``raw`` holds the full response body.
    """

    decision: Decision
    reason_codes: List[str]
    policy_version_id: Optional[str]
    matched_rule_index: Optional[int]
    approval_id: Optional[str]
    approval_status: Optional[ApprovalStatus]
    limits: Dict[str, Any]
    raw: Dict[str, Any] = field(repr=False, compare=False)

    @property
    def allowed(self) -> bool:
        return self.decision == "allow"

    @property
    def denied(self) -> bool:
        return self.decision == "deny"

    @property
    def pending_approval(self) -> bool:
        return self.decision == "require_approval"

    @classmethod
    def from_response(cls, body: Dict[str, Any]) -> "AuthorizationDecision":
        return cls(
            decision=body["decision"],
            reason_codes=list(body.get("reasonCodes") or []),
            policy_version_id=body.get("policyVersionId"),
            matched_rule_index=body.get("matchedRuleIndex"),
            approval_id=body.get("approvalId"),
            approval_status=body.get("approvalStatus"),
            limits=dict(body.get("limits") or {}),
            raw=body,
        )
