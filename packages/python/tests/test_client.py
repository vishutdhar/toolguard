from __future__ import annotations

import json
from typing import Any, Dict

import httpx
import pytest
import respx

from toolguard import ApprovalTimeout, ToolGuard, ToolGuardError

from .conftest import BASE

LIMITS = {
    "remainingActionsToday": 10,
    "remainingBudgetUsd": 5.0,
    "remainingToolActionsToday": 3,
    "remainingTokensToday": 100,
}


def decision(kind: str, **extra: Any) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "decision": kind,
        "reasonCodes": ["R1"],
        "policyVersionId": "pv_1",
        "matchedRuleIndex": 0,
        "approvalId": None,
        "approvalStatus": None,
        "limits": LIMITS,
    }
    body.update(extra)
    return body


def sent(route: respx.Route, index: int = -1) -> Dict[str, Any]:
    return json.loads(route.calls[index].request.content)


@pytest.fixture
def tg() -> ToolGuard:
    return ToolGuard(api_key="tg_key", base_url=BASE + "/", org_id="org_1", agent_id="agent_1")


def test_sends_bearer_key_and_strips_trailing_slash(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    route = mock_api.get("/healthz").respond(200, json={"status": "ok", "service": "toolguard-api"})
    assert tg.health()["status"] == "ok"
    request = route.calls[0].request
    assert request.headers["authorization"] == "Bearer tg_key"
    assert str(request.url) == BASE + "/healthz"


def test_bootstrap_works_without_api_key(mock_api: respx.MockRouter) -> None:
    route = mock_api.post("/v1/organizations").respond(
        201, json={"organization": {"id": "org_9"}, "apiKey": {"id": "k"}, "rawApiKey": "tg_raw"}
    )
    with ToolGuard(base_url=BASE) as client:
        result = client.bootstrap("Acme")
    assert result["rawApiKey"] == "tg_raw"
    assert "authorization" not in route.calls[0].request.headers
    assert sent(route) == {"name": "Acme", "apiKeyName": "Default key"}


def test_error_shape_maps_to_toolguard_error(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    mock_api.post("/v1/api-keys").respond(
        403,
        json={"error": "SCOPE_ESCALATION", "message": "too broad", "details": {"notHeld": ["*"]}},
    )
    with pytest.raises(ToolGuardError) as info:
        tg.create_api_key("child", scopes=["*"])
    err = info.value
    assert (err.status_code, err.code, err.details) == (403, "SCOPE_ESCALATION", {"notHeld": ["*"]})
    assert str(err) == "too broad"


def test_null_details_become_none(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    mock_api.get("/v1/approvals/ap_1").respond(404, json={"error": "NOT_FOUND", "message": "nope", "details": None})
    with pytest.raises(ToolGuardError) as info:
        tg.get_approval("ap_1")
    assert info.value.details is None


def test_non_json_error_is_invalid_response(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    mock_api.get("/v1/tools").respond(502, text="<html>bad gateway</html>")
    with pytest.raises(ToolGuardError) as info:
        tg.list_tools()
    assert info.value.code == "INVALID_RESPONSE"
    assert info.value.status_code == 502


def test_missing_org_and_agent_ids_raise_before_request(mock_api: respx.MockRouter) -> None:
    client = ToolGuard(api_key="k", base_url=BASE)
    with pytest.raises(ToolGuardError) as info:
        client.create_agent("a", "production")
    assert info.value.code == "MISSING_ORG_ID"
    with pytest.raises(ToolGuardError) as info:
        client.create_session(org_id="org_1")
    assert info.value.code == "MISSING_AGENT_ID"
    assert not mock_api.calls


def test_create_api_key_omits_scopes_unless_given(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    route = mock_api.post("/v1/api-keys").respond(201, json={"apiKey": {}, "rawApiKey": "x"})
    tg.create_api_key("a")
    tg.create_api_key("b", scopes=["tool:authorize"])
    assert sent(route, 0) == {"orgId": "org_1", "name": "a"}
    assert sent(route, 1) == {"orgId": "org_1", "name": "b", "scopes": ["tool:authorize"]}


def test_agents_sessions_tools(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    agents = mock_api.post("/v1/agents").respond(201, json={"id": "agent_2"})
    mock_api.get("/v1/agents").respond(200, json={"items": [{"id": "agent_2"}]})
    sessions = mock_api.post("/v1/sessions").respond(201, json={"id": "sess_1"})
    tools = mock_api.post("/v1/tools").respond(201, json={"id": "tool_1"})
    mock_api.get("/v1/tools").respond(200, json={"items": [{"id": "tool_1"}]})

    tg.create_agent("support", "production", description="d", default_scopes=["gmail:send"])
    assert sent(agents) == {
        "orgId": "org_1",
        "name": "support",
        "environment": "production",
        "defaultScopes": ["gmail:send"],
        "description": "d",
    }
    assert tg.list_agents() == [{"id": "agent_2"}]

    tg.create_session(scopes=["gmail:send"], user_id="u1", metadata={"k": 1})
    assert sent(sessions) == {
        "orgId": "org_1",
        "agentId": "agent_1",
        "userId": "u1",
        "servicePrincipal": None,
        "scopes": ["gmail:send"],
        "metadata": {"k": 1},
    }

    tg.create_tool("stripe.refund", "refund", "stripe", "high", estimated_cost_usd=1.5)
    assert sent(tools) == {
        "orgId": "org_1",
        "name": "stripe.refund",
        "action": "refund",
        "resource": "stripe",
        "riskLevel": "high",
        "estimatedCostUsd": 1.5,
    }
    assert tg.list_tools() == [{"id": "tool_1"}]


def test_policies_and_versions(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    rule = {"if": {"tool.name": "stripe.refund"}, "then": {"decision": "deny", "reasonCodes": ["NO"]}}
    create = mock_api.post("/v1/policies").respond(201, json={"id": "pol_1", "versions": []})
    mock_api.get("/v1/policies/pol%2F1").respond(200, json={"id": "pol/1"})
    version = mock_api.post("/v1/policies/pol_1/versions").respond(201, json={"versionNumber": 2})

    tg.create_policy("No refunds", rules=[rule])  # type: ignore[list-item]
    assert sent(create) == {"orgId": "org_1", "name": "No refunds", "isActive": True, "rulesJson": [rule]}
    assert tg.get_policy("pol/1")["id"] == "pol/1"
    assert tg.create_policy_version("pol_1", [rule])["versionNumber"] == 2  # type: ignore[list-item]
    assert sent(version) == {"rulesJson": [rule]}


def test_evaluate_policy_and_usage(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    evaluate = mock_api.post("/v1/policy/evaluate").respond(200, json=decision("deny"))
    usage = mock_api.post("/v1/usage/check").respond(
        200, json={"allowed": True, "reasonCodes": [], "windowKey": "w", "limits": LIMITS}
    )
    tg.evaluate_policy("sess_1", {"name": "stripe.refund"}, payload_summary={"amountUsd": 10})
    assert sent(evaluate) == {
        "orgId": "org_1",
        "agentId": "agent_1",
        "sessionId": "sess_1",
        "tool": {"name": "stripe.refund"},
        "context": {},
        "payloadSummary": {"amountUsd": 10},
    }
    assert tg.check_usage("stripe.refund", reserve=True)["allowed"] is True
    assert sent(usage)["reserve"] is True


@pytest.mark.parametrize(
    ("kind", "allowed", "denied", "pending"),
    [("allow", True, False, False), ("deny", False, True, False), ("require_approval", False, False, True)],
)
def test_authorize_decision_helpers(
    tg: ToolGuard, mock_api: respx.MockRouter, kind: str, allowed: bool, denied: bool, pending: bool
) -> None:
    route = mock_api.post("/v1/tool/authorize").respond(200, json=decision(kind, approvalId="ap_1"))
    result = tg.authorize("sess_1", {"name": "gmail.send_email"}, context={"why": "x"}, run_id="run_1")
    assert (result.allowed, result.denied, result.pending_approval) == (allowed, denied, pending)
    assert result.approval_id == "ap_1"
    assert result.reason_codes == ["R1"]
    assert result.raw["limits"] == LIMITS
    assert sent(route) == {
        "orgId": "org_1",
        "agentId": "agent_1",
        "sessionId": "sess_1",
        "runId": "run_1",
        "approvalId": None,
        "invocationId": None,
        "tool": {"name": "gmail.send_email"},
        "context": {"why": "x"},
        "payloadSummary": {},
        "tokenCount": 0,
    }


def test_approvals(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    request = mock_api.post("/v1/approvals/request").respond(201, json={"id": "ap_1", "status": "pending"})
    listing = mock_api.get("/v1/approvals").respond(200, json={"items": [], "cursor": "c2"})
    resolve = mock_api.post("/v1/approvals/ap_1/resolve").respond(200, json={"id": "ap_1", "status": "approved"})

    tg.request_approval("sess_1", "stripe.refund", "refund", "stripe", ["HIGH_RISK"], justification="why")
    assert sent(request) == {
        "orgId": "org_1",
        "sessionId": "sess_1",
        "runId": None,
        "reasonCodes": ["HIGH_RISK"],
        "toolName": "stripe.refund",
        "action": "refund",
        "resource": "stripe",
        "justification": "why",
        "requestedByAgentId": "agent_1",
    }
    page = tg.list_approvals(status="pending", limit=5)
    assert page["cursor"] == "c2"
    assert dict(listing.calls[0].request.url.params) == {"status": "pending", "limit": "5"}

    assert tg.approve("ap_1")["status"] == "approved"
    tg.reject("ap_1")
    assert [sent(resolve, i) for i in range(2)] == [{"status": "approved"}, {"status": "rejected"}]
    with pytest.raises(ToolGuardError):
        tg.resolve_approval("ap_1", "maybe")


def test_audit_events_paginate_with_cursor(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    create = mock_api.post("/v1/audit/events").respond(201, json={"id": "ev_1"})
    pages = mock_api.get("/v1/audit/events").mock(
        side_effect=[
            httpx.Response(200, json={"items": [{"id": "ev_1"}], "cursor": "next"}),
            httpx.Response(200, json={"items": [{"id": "ev_2"}], "cursor": None}),
        ]
    )
    tg.create_audit_event("custom.event", "agent", actor_id="agent_1", payload={"a": 1})
    assert sent(create) == {
        "orgId": "org_1",
        "sessionId": None,
        "runId": None,
        "eventType": "custom.event",
        "actorType": "agent",
        "actorId": "agent_1",
        "payload": {"a": 1},
    }

    seen = []
    cursor = None
    while True:
        page = tg.list_audit_events(cursor=cursor, limit=1)
        seen += [item["id"] for item in page["items"]]
        cursor = page["cursor"]
        if not cursor:
            break
    assert seen == ["ev_1", "ev_2"]
    assert "cursor" not in pages.calls[0].request.url.params
    assert pages.calls[1].request.url.params["cursor"] == "next"


def test_runs(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    create = mock_api.post("/v1/runs").respond(201, json={"id": "run_1"})
    complete = mock_api.post("/v1/runs/run_1/complete").respond(200, json={"status": "failed"})
    mock_api.get("/v1/runs/run_1/replay").respond(
        200, json={"items": [{"timestamp": "t", "eventType": "run.started", "payload": {}}]}
    )
    tg.create_run("sess_1", prompt_summary="p")
    assert sent(create) == {"orgId": "org_1", "sessionId": "sess_1", "promptSummary": "p", "metadata": {}}
    tg.complete_run("run_1", "failed")
    assert sent(complete) == {"status": "failed"}
    assert tg.replay("run_1")[0]["eventType"] == "run.started"


def test_webhooks(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    create = mock_api.post("/v1/webhooks").respond(201, json={"id": "wh_1"})
    mock_api.get("/v1/webhooks").respond(200, json={"items": [{"id": "wh_1"}]})
    delete = mock_api.delete("/v1/webhooks/wh_1").respond(204)
    tg.create_webhook("https://example.com/hook", ["approval.requested"], secret="s")
    assert sent(create) == {"url": "https://example.com/hook", "eventTypes": ["approval.requested"], "secret": "s"}
    assert tg.list_webhooks() == [{"id": "wh_1"}]
    assert tg.delete_webhook("wh_1") is None
    assert delete.called


def test_wait_for_approval_polls_then_reauthorizes(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    mock_api.get("/v1/approvals/ap_1").mock(
        side_effect=[
            httpx.Response(200, json={"id": "ap_1", "status": "pending"}),
            httpx.Response(200, json={"id": "ap_1", "status": "approved"}),
        ]
    )
    authorize = mock_api.post("/v1/tool/authorize").respond(
        200, json=decision("allow", approvalId="ap_1", approvalStatus="approved")
    )
    result = tg.wait_for_approval(
        "ap_1", "sess_1", {"name": "stripe.refund"}, payload_summary={"amountUsd": 5}, poll_interval=0.01
    )
    assert result.allowed
    body = sent(authorize)
    assert body["approvalId"] == "ap_1"
    assert body["payloadSummary"] == {"amountUsd": 5}
    assert isinstance(body["invocationId"], str) and len(body["invocationId"]) == 36


def test_wait_for_approval_keeps_given_invocation_id(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    mock_api.get("/v1/approvals/ap_1").respond(200, json={"id": "ap_1", "status": "rejected"})
    authorize = mock_api.post("/v1/tool/authorize").respond(
        200, json=decision("deny", reasonCodes=["APPROVAL_REJECTED"])
    )
    result = tg.wait_for_approval("ap_1", "sess_1", {"name": "stripe.refund"}, invocation_id="inv_1")
    assert result.denied
    assert sent(authorize)["invocationId"] == "inv_1"


def test_wait_for_approval_times_out(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    mock_api.get("/v1/approvals/ap_1").respond(200, json={"id": "ap_1", "status": "pending"})
    authorize = mock_api.post("/v1/tool/authorize")
    with pytest.raises(ApprovalTimeout) as info:
        tg.wait_for_approval("ap_1", "sess_1", {"name": "x"}, timeout=0.05, poll_interval=0.01)
    assert info.value.code == "APPROVAL_TIMEOUT"
    assert not authorize.called
