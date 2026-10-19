"""Synchronous ToolGuard client.

AsyncToolGuard in _async_client.py is generated from this file by
scripts/gen_async.py. Edit this file, then run the script.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Mapping, Optional, Sequence, cast
from urllib.parse import quote

import httpx

from ._base import DEFAULT_BASE_URL, DEFAULT_TIMEOUT, ClientConfig, compact, handle_response
from .errors import ApprovalTimeout, ToolGuardError
from .types import (
    Agent,
    ApiKeyResult,
    Approval,
    AuditEvent,
    AuthorizationDecision,
    BootstrapResult,
    EvaluatePolicyResult,
    HealthCheck,
    Page,
    Policy,
    PolicyRule,
    PolicyVersion,
    ReplayItem,
    RiskLevel,
    Run,
    RunStatus,
    Session,
    Tool,
    ToolInput,
    UsageCheckResult,
    WebhookConfig,
)


def _p(value: str) -> str:
    return quote(value, safe="")


class ToolGuard:
    """Client for the ToolGuard API.

    ``org_id`` and ``agent_id`` set defaults so most calls can leave them out.
    ``api_key`` is optional only for ``bootstrap()`` (self-signup).
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        org_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        self._config = ClientConfig(api_key=api_key, base_url=base_url, org_id=org_id, agent_id=agent_id)
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client(timeout=timeout)

    # --- lifecycle ---

    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> "ToolGuard":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    # --- HTTP ---

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Mapping[str, Any]] = None,
        params: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        response = self._http.request(
            method,
            self._config.url(path),
            json=json,
            params=compact(params) if params else None,
            headers=self._config.headers(),
        )
        return handle_response(response, method, path)

    # --- health and bootstrap ---

    def health(self) -> HealthCheck:
        """GET /healthz. Raises ToolGuardError with status 503 when the server is degraded."""
        return cast(HealthCheck, self._request("GET", "/healthz"))

    def bootstrap(self, name: str, api_key_name: str = "Default key") -> BootstrapResult:
        """Create an organization and its first full-access API key (self-signup)."""
        return cast(
            BootstrapResult,
            self._request("POST", "/v1/organizations", json={"name": name, "apiKeyName": api_key_name}),
        )

    create_organization = bootstrap

    # --- API keys ---

    def create_api_key(
        self,
        name: str,
        *,
        scopes: Optional[Sequence[str]] = None,
        org_id: Optional[str] = None,
    ) -> ApiKeyResult:
        """Create an API key.

        The calling key needs the ``api_keys:create`` capability, and ``scopes``
        must be a subset of its own scopes. Leave ``scopes`` out to copy the
        caller's scopes.
        """
        body: Dict[str, Any] = {"orgId": self._config.require_org(org_id), "name": name}
        if scopes is not None:
            body["scopes"] = list(scopes)
        return cast(ApiKeyResult, self._request("POST", "/v1/api-keys", json=body))

    # --- agents ---

    def create_agent(
        self,
        name: str,
        environment: str,
        *,
        description: Optional[str] = None,
        default_scopes: Optional[Sequence[str]] = None,
        org_id: Optional[str] = None,
    ) -> Agent:
        body = {
            "orgId": self._config.require_org(org_id),
            "name": name,
            "environment": environment,
            "defaultScopes": list(default_scopes or []),
        }
        if description is not None:
            body["description"] = description
        return cast(Agent, self._request("POST", "/v1/agents", json=body))

    def list_agents(self) -> List[Agent]:
        return cast(List[Agent], self._request("GET", "/v1/agents")["items"])

    # --- sessions ---

    def create_session(
        self,
        *,
        scopes: Optional[Sequence[str]] = None,
        environment: Optional[str] = None,
        user_id: Optional[str] = None,
        service_principal: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        agent_id: Optional[str] = None,
        org_id: Optional[str] = None,
    ) -> Session:
        """Create a session. ``environment``, if given, must match the agent's environment."""
        body: Dict[str, Any] = {
            "orgId": self._config.require_org(org_id),
            "agentId": self._config.require_agent(agent_id),
            "userId": user_id,
            "servicePrincipal": service_principal,
            "scopes": list(scopes or []),
            "metadata": dict(metadata or {}),
        }
        if environment is not None:
            body["environment"] = environment
        return cast(Session, self._request("POST", "/v1/sessions", json=body))

    # --- tools ---

    def create_tool(
        self,
        name: str,
        action: str,
        resource: str,
        risk_level: RiskLevel,
        *,
        description: Optional[str] = None,
        estimated_cost_usd: float = 0,
        org_id: Optional[str] = None,
    ) -> Tool:
        body: Dict[str, Any] = {
            "orgId": self._config.require_org(org_id),
            "name": name,
            "action": action,
            "resource": resource,
            "riskLevel": risk_level,
            "estimatedCostUsd": estimated_cost_usd,
        }
        if description is not None:
            body["description"] = description
        return cast(Tool, self._request("POST", "/v1/tools", json=body))

    def list_tools(self) -> List[Tool]:
        return cast(List[Tool], self._request("GET", "/v1/tools")["items"])

    # --- policies ---

    def create_policy(
        self,
        name: str,
        *,
        rules: Optional[Sequence[PolicyRule]] = None,
        description: Optional[str] = None,
        is_active: bool = True,
        org_id: Optional[str] = None,
    ) -> Policy:
        """Create a policy. If ``rules`` is given, it becomes version 1."""
        body: Dict[str, Any] = {
            "orgId": self._config.require_org(org_id),
            "name": name,
            "isActive": is_active,
        }
        if description is not None:
            body["description"] = description
        if rules is not None:
            body["rulesJson"] = list(rules)
        return cast(Policy, self._request("POST", "/v1/policies", json=body))

    def get_policy(self, policy_id: str) -> Policy:
        return cast(Policy, self._request("GET", f"/v1/policies/{_p(policy_id)}"))

    def create_policy_version(self, policy_id: str, rules: Sequence[PolicyRule]) -> PolicyVersion:
        return cast(
            PolicyVersion,
            self._request("POST", f"/v1/policies/{_p(policy_id)}/versions", json={"rulesJson": list(rules)}),
        )

    def evaluate_policy(
        self,
        session_id: str,
        tool: ToolInput,
        *,
        context: Optional[Mapping[str, Any]] = None,
        payload_summary: Optional[Mapping[str, Any]] = None,
        agent_id: Optional[str] = None,
        org_id: Optional[str] = None,
    ) -> EvaluatePolicyResult:
        """Dry-run the policy for a tool call. Nothing is reserved or audited."""
        body = {
            "orgId": self._config.require_org(org_id),
            "agentId": self._config.require_agent(agent_id),
            "sessionId": session_id,
            "tool": dict(tool),
            "context": dict(context or {}),
            "payloadSummary": dict(payload_summary or {}),
        }
        return cast(EvaluatePolicyResult, self._request("POST", "/v1/policy/evaluate", json=body))

    # --- usage ---

    def check_usage(
        self,
        tool_name: str,
        *,
        estimated_cost_usd: float = 0,
        token_count: int = 0,
        reserve: bool = False,
        org_id: Optional[str] = None,
    ) -> UsageCheckResult:
        body = {
            "orgId": self._config.require_org(org_id),
            "toolName": tool_name,
            "estimatedCostUsd": estimated_cost_usd,
            "tokenCount": token_count,
            "reserve": reserve,
        }
        return cast(UsageCheckResult, self._request("POST", "/v1/usage/check", json=body))

    # --- authorization ---

    def authorize(
        self,
        session_id: str,
        tool: ToolInput,
        *,
        context: Optional[Mapping[str, Any]] = None,
        payload_summary: Optional[Mapping[str, Any]] = None,
        run_id: Optional[str] = None,
        approval_id: Optional[str] = None,
        invocation_id: Optional[str] = None,
        token_count: int = 0,
        agent_id: Optional[str] = None,
        org_id: Optional[str] = None,
    ) -> AuthorizationDecision:
        """Ask ToolGuard whether a tool call may run.

        On ``require_approval`` the server creates an approval and returns its
        id. Once a human approves it, call again with ``approval_id`` (and an
        ``invocation_id`` so a retry does not consume a second approval), or
        use ``wait_for_approval()``.
        """
        body = {
            "orgId": self._config.require_org(org_id),
            "agentId": self._config.require_agent(agent_id),
            "sessionId": session_id,
            "runId": run_id,
            "approvalId": approval_id,
            "invocationId": invocation_id,
            "tool": dict(tool),
            "context": dict(context or {}),
            "payloadSummary": dict(payload_summary or {}),
            "tokenCount": token_count,
        }
        return AuthorizationDecision.from_response(self._request("POST", "/v1/tool/authorize", json=body))

    def wait_for_approval(
        self,
        approval_id: str,
        session_id: str,
        tool: ToolInput,
        *,
        context: Optional[Mapping[str, Any]] = None,
        payload_summary: Optional[Mapping[str, Any]] = None,
        run_id: Optional[str] = None,
        invocation_id: Optional[str] = None,
        token_count: int = 0,
        agent_id: Optional[str] = None,
        org_id: Optional[str] = None,
        timeout: float = 300.0,
        poll_interval: float = 2.0,
    ) -> AuthorizationDecision:
        """Poll an approval until a human resolves it, then authorize again.

        Pass the same session, tool, context and payload summary as the
        original ``authorize()`` call. The re-authorization sends
        ``approval_id`` and ``invocation_id`` (a new UUID if you leave it out).
        An approved request comes back as ``allow`` and a rejected one as
        ``deny``. Raises ApprovalTimeout if the approval is still pending
        after ``timeout`` seconds.
        """
        deadline = time.monotonic() + timeout
        while True:
            approval = self.get_approval(approval_id)
            if approval.get("status") != "pending":
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ApprovalTimeout(approval_id, timeout)
            time.sleep(min(poll_interval, remaining))

        return self.authorize(
            session_id,
            tool,
            context=context,
            payload_summary=payload_summary,
            run_id=run_id,
            approval_id=approval_id,
            invocation_id=invocation_id or str(uuid.uuid4()),
            token_count=token_count,
            agent_id=agent_id,
            org_id=org_id,
        )

    # --- approvals ---

    def request_approval(
        self,
        session_id: str,
        tool_name: str,
        action: str,
        resource: str,
        reason_codes: Sequence[str],
        *,
        requested_by_agent_id: Optional[str] = None,
        justification: Optional[str] = None,
        run_id: Optional[str] = None,
        org_id: Optional[str] = None,
    ) -> Approval:
        """Create an approval request by hand. ``authorize()`` does this for you on require_approval."""
        body = {
            "orgId": self._config.require_org(org_id),
            "sessionId": session_id,
            "runId": run_id,
            "reasonCodes": list(reason_codes),
            "toolName": tool_name,
            "action": action,
            "resource": resource,
            "justification": justification,
            "requestedByAgentId": self._config.require_agent(requested_by_agent_id),
        }
        return cast(Approval, self._request("POST", "/v1/approvals/request", json=body))

    def get_approval(self, approval_id: str) -> Approval:
        return cast(Approval, self._request("GET", f"/v1/approvals/{_p(approval_id)}"))

    def list_approvals(
        self,
        *,
        status: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Page:
        return cast(
            Page,
            self._request("GET", "/v1/approvals", params={"status": status, "cursor": cursor, "limit": limit}),
        )

    def resolve_approval(self, approval_id: str, status: str) -> Approval:
        """Approve or reject. ``status`` is "approved" or "rejected". Needs the approvals:resolve capability."""
        if status not in ("approved", "rejected"):
            raise ToolGuardError('status must be "approved" or "rejected"', 400, "INVALID_STATUS")
        return cast(
            Approval,
            self._request("POST", f"/v1/approvals/{_p(approval_id)}/resolve", json={"status": status}),
        )

    def approve(self, approval_id: str) -> Approval:
        return self.resolve_approval(approval_id, "approved")

    def reject(self, approval_id: str) -> Approval:
        return self.resolve_approval(approval_id, "rejected")

    # --- audit ---

    def create_audit_event(
        self,
        event_type: str,
        actor_type: str,
        *,
        actor_id: Optional[str] = None,
        session_id: Optional[str] = None,
        run_id: Optional[str] = None,
        payload: Optional[Mapping[str, Any]] = None,
        org_id: Optional[str] = None,
    ) -> AuditEvent:
        body = {
            "orgId": self._config.require_org(org_id),
            "sessionId": session_id,
            "runId": run_id,
            "eventType": event_type,
            "actorType": actor_type,
            "actorId": actor_id,
            "payload": dict(payload or {}),
        }
        return cast(AuditEvent, self._request("POST", "/v1/audit/events", json=body))

    ingest_audit_event = create_audit_event

    def list_audit_events(self, *, cursor: Optional[str] = None, limit: Optional[int] = None) -> Page:
        """One page of audit events. Pass the returned ``cursor`` to get the next page."""
        return cast(Page, self._request("GET", "/v1/audit/events", params={"cursor": cursor, "limit": limit}))

    # --- runs ---

    def create_run(
        self,
        session_id: str,
        *,
        prompt_summary: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        org_id: Optional[str] = None,
    ) -> Run:
        body = {
            "orgId": self._config.require_org(org_id),
            "sessionId": session_id,
            "promptSummary": prompt_summary,
            "metadata": dict(metadata or {}),
        }
        return cast(Run, self._request("POST", "/v1/runs", json=body))

    def complete_run(self, run_id: str, status: RunStatus = "completed") -> Run:
        return cast(Run, self._request("POST", f"/v1/runs/{_p(run_id)}/complete", json={"status": status}))

    def replay(self, run_id: str) -> List[ReplayItem]:
        return cast(List[ReplayItem], self._request("GET", f"/v1/runs/{_p(run_id)}/replay")["items"])

    # --- webhooks ---

    def create_webhook(
        self,
        url: str,
        event_types: Sequence[str],
        *,
        secret: Optional[str] = None,
    ) -> WebhookConfig:
        """Register a webhook. With a ``secret``, deliveries carry X-ToolGuard-Signature (see verify_webhook_signature)."""
        body = {"url": url, "eventTypes": list(event_types), "secret": secret}
        return cast(WebhookConfig, self._request("POST", "/v1/webhooks", json=body))

    def list_webhooks(self) -> List[WebhookConfig]:
        return cast(List[WebhookConfig], self._request("GET", "/v1/webhooks")["items"])

    def delete_webhook(self, webhook_id: str) -> None:
        self._request("DELETE", f"/v1/webhooks/{_p(webhook_id)}")
