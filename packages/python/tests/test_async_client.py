from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
import respx

from toolguard import AsyncToolGuard, ToolGuardError

from .conftest import BASE

ROOT = Path(__file__).resolve().parent.parent


def test_generated_async_client_is_up_to_date() -> None:
    result = subprocess.run([sys.executable, "scripts/gen_async.py", "--check"], cwd=ROOT)
    assert result.returncode == 0


def test_async_client_has_every_public_method() -> None:
    from toolguard import ToolGuard

    sync_methods = {name for name in dir(ToolGuard) if not name.startswith("_")}
    async_methods = {name for name in dir(AsyncToolGuard) if not name.startswith("_")}
    assert sync_methods == async_methods


async def test_async_authorize_and_errors(mock_api: respx.MockRouter) -> None:
    route = mock_api.post("/v1/tool/authorize").respond(
        200,
        json={
            "decision": "require_approval",
            "reasonCodes": ["HIGH_RISK"],
            "policyVersionId": None,
            "matchedRuleIndex": None,
            "approvalId": "ap_1",
            "approvalStatus": "pending",
            "limits": {},
        },
    )
    mock_api.get("/v1/agents").respond(401, json={"error": "UNAUTHORIZED", "message": "bad key"})
    async with AsyncToolGuard(api_key="k", base_url=BASE, org_id="org_1", agent_id="agent_1") as tg:
        result = await tg.authorize("sess_1", {"name": "gmail.send_email"})
        assert result.pending_approval and result.approval_id == "ap_1"
        assert json.loads(route.calls[0].request.content)["agentId"] == "agent_1"
        with pytest.raises(ToolGuardError) as info:
            await tg.list_agents()
        assert info.value.code == "UNAUTHORIZED"


async def test_async_wait_for_approval(mock_api: respx.MockRouter) -> None:
    mock_api.get("/v1/approvals/ap_1").mock(
        side_effect=[
            httpx.Response(200, json={"status": "pending"}),
            httpx.Response(200, json={"status": "approved"}),
        ]
    )
    authorize = mock_api.post("/v1/tool/authorize").respond(
        200,
        json={
            "decision": "allow",
            "reasonCodes": [],
            "policyVersionId": None,
            "matchedRuleIndex": None,
            "approvalId": "ap_1",
            "approvalStatus": "approved",
            "limits": {},
        },
    )
    async with AsyncToolGuard(api_key="k", base_url=BASE, org_id="org_1", agent_id="agent_1") as tg:
        result = await tg.wait_for_approval("ap_1", "sess_1", {"name": "x"}, poll_interval=0.01)
    assert result.allowed
    assert json.loads(authorize.calls[0].request.content)["approvalId"] == "ap_1"


async def test_async_delete_webhook_returns_none(mock_api: respx.MockRouter) -> None:
    mock_api.delete("/v1/webhooks/wh_1").respond(204)
    async with AsyncToolGuard(api_key="k", base_url=BASE) as tg:
        assert await tg.delete_webhook("wh_1") is None
