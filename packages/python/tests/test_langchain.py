from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx
import pytest
import respx

pytest.importorskip("langchain_core")

from langchain_core.tools import tool  # noqa: E402

from toolguard import ApprovalRequired, AsyncToolGuard, ToolCallDenied, ToolGuard  # noqa: E402
from toolguard.langchain import AsyncToolGuardCallbackHandler, ToolGuardCallbackHandler, ToolMapping  # noqa: E402

from .conftest import BASE  # noqa: E402

calls: List[Dict[str, Any]] = []


@tool
def issue_refund(payment_id: str, amount_usd: float) -> str:
    """Refund a payment."""
    calls.append({"payment_id": payment_id, "amount_usd": amount_usd})
    return f"refunded {amount_usd}"


@tool
async def issue_refund_async(payment_id: str, amount_usd: float) -> str:
    """Refund a payment (async)."""
    calls.append({"payment_id": payment_id, "amount_usd": amount_usd})
    return f"refunded {amount_usd}"


def decision(kind: str, **extra: Any) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "decision": kind,
        "reasonCodes": ["RULE"],
        "policyVersionId": None,
        "matchedRuleIndex": None,
        "approvalId": None,
        "approvalStatus": None,
        "limits": {},
    }
    body.update(extra)
    return body


REFUND = ToolMapping(
    name="stripe.refund",
    context={"justification": "customer asked"},
    payload_summary=lambda args: {"amountUsd": args["amount_usd"]},
)
TOOL_MAP = {"issue_refund": REFUND, "issue_refund_async": REFUND}


@pytest.fixture(autouse=True)
def reset_calls() -> None:
    calls.clear()


@pytest.fixture
def tg() -> ToolGuard:
    return ToolGuard(api_key="k", base_url=BASE, org_id="org_1", agent_id="agent_1")


def test_allow_runs_the_tool_and_sends_mapped_fields(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    route = mock_api.post("/v1/tool/authorize").respond(200, json=decision("allow"))
    handler = ToolGuardCallbackHandler(tg, "sess_1", tool_map=TOOL_MAP, run_id="run_1")
    out = issue_refund.invoke({"payment_id": "pi_1", "amount_usd": 20.0}, config={"callbacks": [handler]})
    assert out == "refunded 20.0"
    assert calls == [{"payment_id": "pi_1", "amount_usd": 20.0}]
    body = json.loads(route.calls[0].request.content)
    assert body["tool"] == {"name": "stripe.refund"}
    assert body["sessionId"] == "sess_1"
    assert body["runId"] == "run_1"
    assert body["context"] == {"justification": "customer asked"}
    assert body["payloadSummary"] == {"amountUsd": 20.0}
    assert body["invocationId"]
    assert len(handler.decisions) == 1


def test_deny_raises_and_skips_the_tool(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    mock_api.post("/v1/tool/authorize").respond(200, json=decision("deny", reasonCodes=["REFUND_THRESHOLD_EXCEEDED"]))
    handler = ToolGuardCallbackHandler(tg, "sess_1", tool_map=TOOL_MAP)
    with pytest.raises(ToolCallDenied) as info:
        issue_refund.invoke({"payment_id": "pi_1", "amount_usd": 5000.0}, config={"callbacks": [handler]})
    assert info.value.decision.reason_codes == ["REFUND_THRESHOLD_EXCEEDED"]
    assert "REFUND_THRESHOLD_EXCEEDED" in str(info.value)
    assert calls == []


def test_require_approval_raises_with_approval_id(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    mock_api.post("/v1/tool/authorize").respond(
        200, json=decision("require_approval", approvalId="ap_1", approvalStatus="pending")
    )
    handler = ToolGuardCallbackHandler(tg, "sess_1", tool_map=TOOL_MAP)
    with pytest.raises(ApprovalRequired) as info:
        issue_refund.invoke({"payment_id": "pi_1", "amount_usd": 5.0}, config={"callbacks": [handler]})
    assert info.value.approval_id == "ap_1"
    assert calls == []


def test_wait_for_approval_then_runs(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    authorize = mock_api.post("/v1/tool/authorize").mock(
        side_effect=[
            httpx.Response(200, json=decision("require_approval", approvalId="ap_1", approvalStatus="pending")),
            httpx.Response(200, json=decision("allow", approvalId="ap_1", approvalStatus="approved")),
        ]
    )
    mock_api.get("/v1/approvals/ap_1").mock(
        side_effect=[httpx.Response(200, json={"status": "pending"}), httpx.Response(200, json={"status": "approved"})]
    )
    handler = ToolGuardCallbackHandler(tg, "sess_1", tool_map=TOOL_MAP, wait_for_approval=True, poll_interval=0.01)
    out = issue_refund.invoke({"payment_id": "pi_1", "amount_usd": 5.0}, config={"callbacks": [handler]})
    assert out == "refunded 5.0"
    first, second = (json.loads(call.request.content) for call in authorize.calls)
    assert first["approvalId"] is None
    assert second["approvalId"] == "ap_1"
    assert second["invocationId"] == first["invocationId"]


def test_unmapped_tools_use_their_name_or_skip(tg: ToolGuard, mock_api: respx.MockRouter) -> None:
    route = mock_api.post("/v1/tool/authorize").respond(200, json=decision("allow"))
    issue_refund.invoke(
        {"payment_id": "p", "amount_usd": 1.0}, config={"callbacks": [ToolGuardCallbackHandler(tg, "sess_1")]}
    )
    assert json.loads(route.calls[0].request.content)["tool"] == {"name": "issue_refund"}

    issue_refund.invoke(
        {"payment_id": "p", "amount_usd": 1.0},
        config={"callbacks": [ToolGuardCallbackHandler(tg, "sess_1", unmapped="skip")]},
    )
    assert route.call_count == 1

    issue_refund.invoke(
        {"payment_id": "p", "amount_usd": 1.0},
        config={"callbacks": [ToolGuardCallbackHandler(tg, "sess_1", tool_map={"issue_refund": "stripe.refund"})]},
    )
    assert json.loads(route.calls[1].request.content)["tool"] == {"name": "stripe.refund"}


async def test_async_handler_denies(mock_api: respx.MockRouter) -> None:
    mock_api.post("/v1/tool/authorize").respond(200, json=decision("deny"))
    async with AsyncToolGuard(api_key="k", base_url=BASE, org_id="org_1", agent_id="agent_1") as tg:
        handler = AsyncToolGuardCallbackHandler(tg, "sess_1", tool_map=TOOL_MAP)
        with pytest.raises(ToolCallDenied):
            await issue_refund_async.ainvoke({"payment_id": "p", "amount_usd": 1.0}, config={"callbacks": [handler]})
    assert calls == []


async def test_async_handler_allows(mock_api: respx.MockRouter) -> None:
    mock_api.post("/v1/tool/authorize").respond(200, json=decision("allow"))
    async with AsyncToolGuard(api_key="k", base_url=BASE, org_id="org_1", agent_id="agent_1") as tg:
        handler = AsyncToolGuardCallbackHandler(tg, "sess_1", tool_map=TOOL_MAP)
        out = await issue_refund_async.ainvoke({"payment_id": "p", "amount_usd": 2.0}, config={"callbacks": [handler]})
    assert out == "refunded 2.0"
