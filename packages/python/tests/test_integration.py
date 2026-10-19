"""End to end against a real ToolGuard server in memory mode.

The test starts ``node dist/src/server.js`` from the repo root, so run
``npm ci && npm run build`` there first. Set TOOLGUARD_TEST_URL to use a
server that is already running instead. Without either, the tests skip,
unless TOOLGUARD_REQUIRE_INTEGRATION=1 (set in CI) makes them fail.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterator

import httpx
import pytest

from toolguard import ApprovalRequired, ToolCallDenied, ToolGuard, ToolGuardError

pytestmark = pytest.mark.integration

REPO_ROOT = Path(__file__).resolve().parents[3]
SERVER_JS = REPO_ROOT / "dist" / "src" / "server.js"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    existing = os.environ.get("TOOLGUARD_TEST_URL")
    if existing:
        yield existing.rstrip("/")
        return

    node = shutil.which("node")
    if not node or not SERVER_JS.exists():
        message = "Build the server (npm run build) or set TOOLGUARD_TEST_URL to run integration tests"
        if os.environ.get("TOOLGUARD_REQUIRE_INTEGRATION") == "1":
            pytest.fail(message)
        pytest.skip(message)

    port = _free_port()
    env = {
        **os.environ,
        "NODE_ENV": "development",
        "STORAGE_MODE": "memory",
        "BULLMQ_ENABLED": "false",
        "ALLOW_SELF_SIGNUP": "true",
        "ENABLE_SWAGGER": "false",
        "HOST": "127.0.0.1",
        "PORT": str(port),
        "LOG_LEVEL": "silent",
    }
    proc = subprocess.Popen([node, str(SERVER_JS)], cwd=REPO_ROOT, env=env)
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                if httpx.get(f"{url}/healthz", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            if proc.poll() is not None or time.monotonic() > deadline:
                pytest.fail("ToolGuard server did not start")
            time.sleep(0.2)
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture(scope="module")
def world(server_url: str) -> Dict[str, Any]:
    with ToolGuard(base_url=server_url) as anon:
        boot = anon.bootstrap(f"py-sdk-{uuid.uuid4().hex[:8]}")
    org_id = boot["organization"]["id"]
    admin = ToolGuard(api_key=boot["rawApiKey"], base_url=server_url, org_id=org_id)
    agent = admin.create_agent("py-support-agent", "production", default_scopes=["stripe:refund"])
    admin.create_tool("stripe.refund", "refund", "stripe", "high", estimated_cost_usd=0.5)
    admin.create_tool("slack.post_message", "post_message", "slack", "low")
    admin.create_policy(
        "Large refunds denied",
        rules=[
            {
                "if": {"tool.name": "stripe.refund", "payloadSummary.amountUsd": {"gt": 1000}},
                "then": {"decision": "deny", "reasonCodes": ["REFUND_THRESHOLD_EXCEEDED"]},
            }
        ],
    )
    admin.create_policy(
        "Internal Slack allowed",
        rules=[
            {
                "if": {"tool.name": "slack.post_message", "payloadSummary.channelType": "internal"},
                "then": {"decision": "allow", "reasonCodes": ["INTERNAL"]},
            }
        ],
    )
    agent_key = admin.create_api_key("agent-runtime", scopes=["tool:authorize"])["rawApiKey"]
    runtime = ToolGuard(api_key=agent_key, base_url=server_url, org_id=org_id, agent_id=agent["id"])
    session = admin.create_session(agent_id=agent["id"], scopes=["stripe:refund", "slack:post_message"])
    run = admin.create_run(session["id"], prompt_summary="python sdk integration")
    return {"admin": admin, "runtime": runtime, "agent": agent, "session": session, "run": run, "org_id": org_id}


def test_health_reports_memory_mode(server_url: str) -> None:
    with ToolGuard(base_url=server_url) as client:
        assert client.health()["storageMode"] == "memory"


def test_allow_deny_and_approval_flow(world: Dict[str, Any]) -> None:
    admin: ToolGuard = world["admin"]
    runtime: ToolGuard = world["runtime"]
    session_id = world["session"]["id"]
    run_id = world["run"]["id"]

    slack = runtime.authorize(
        session_id, {"name": "slack.post_message"}, payload_summary={"channelType": "internal"}, run_id=run_id
    )
    assert slack.allowed, slack

    big = runtime.authorize(session_id, {"name": "stripe.refund"}, payload_summary={"amountUsd": 5000}, run_id=run_id)
    assert big.denied
    assert "REFUND_THRESHOLD_EXCEEDED" in big.reason_codes

    small_args = {"payload_summary": {"amountUsd": 40}, "run_id": run_id}
    pending = runtime.authorize(session_id, {"name": "stripe.refund"}, **small_args)
    assert pending.pending_approval and pending.approval_id

    # The runtime key cannot approve its own request.
    with pytest.raises(ToolGuardError) as info:
        runtime.approve(pending.approval_id)
    assert info.value.code == "CAPABILITY_REQUIRED"

    listed = admin.list_approvals(status="pending")
    assert pending.approval_id in [item["id"] for item in listed["items"]]

    assert admin.approve(pending.approval_id)["status"] == "approved"
    invocation_id = str(uuid.uuid4())
    allowed = runtime.wait_for_approval(
        pending.approval_id,
        session_id,
        {"name": "stripe.refund"},
        invocation_id=invocation_id,
        timeout=10,
        poll_interval=0.1,
        **small_args,
    )
    assert allowed.allowed
    assert admin.get_approval(pending.approval_id)["status"] == "consumed"

    # Retrying with the same invocation id is idempotent.
    retry = runtime.authorize(
        session_id,
        {"name": "stripe.refund"},
        approval_id=pending.approval_id,
        invocation_id=invocation_id,
        **small_args,
    )
    assert retry.allowed

    admin.complete_run(run_id, "completed")
    events = [item["eventType"] for item in admin.replay(run_id)]
    assert events[0] == "run.started"
    assert "approval.consumed" in events
    assert events[-1] == "run.completed"


def test_rejected_approval_comes_back_denied(world: Dict[str, Any]) -> None:
    admin: ToolGuard = world["admin"]
    runtime: ToolGuard = world["runtime"]
    session_id = world["session"]["id"]
    pending = runtime.authorize(session_id, {"name": "stripe.refund"}, payload_summary={"amountUsd": 10})
    assert pending.pending_approval and pending.approval_id
    admin.reject(pending.approval_id)
    result = runtime.wait_for_approval(
        pending.approval_id, session_id, {"name": "stripe.refund"}, payload_summary={"amountUsd": 10}, timeout=5
    )
    assert result.denied
    assert result.reason_codes == ["APPROVAL_REJECTED"]


def test_restricted_key_cannot_escalate(world: Dict[str, Any]) -> None:
    admin: ToolGuard = world["admin"]
    runtime: ToolGuard = world["runtime"]
    with pytest.raises(ToolGuardError) as info:
        runtime.create_api_key("sneaky", scopes=["*"])
    assert info.value.code == "CAPABILITY_REQUIRED"

    manager_key = admin.create_api_key("manager", scopes=["api_keys:create", "tool:authorize"])["rawApiKey"]
    manager = ToolGuard(api_key=manager_key, base_url=admin._config.base_url, org_id=world["org_id"])
    with pytest.raises(ToolGuardError) as info:
        manager.create_api_key("sneaky", scopes=["approvals:resolve"])
    assert info.value.code == "SCOPE_ESCALATION"
    assert info.value.details == {"notHeld": ["approvals:resolve"]}
    assert manager.create_api_key("narrow", scopes=["tool:authorize"])["rawApiKey"]


def test_resources_audit_and_webhooks(world: Dict[str, Any]) -> None:
    admin: ToolGuard = world["admin"]
    assert any(agent["id"] == world["agent"]["id"] for agent in admin.list_agents())
    assert {"stripe.refund", "slack.post_message"} <= {tool["name"] for tool in admin.list_tools()}

    policy = admin.create_policy("Versioned")
    version = admin.create_policy_version(
        policy["id"], [{"if": {"tool.name": "slack.post_message"}, "then": {"decision": "allow"}}]
    )
    assert version["versionNumber"] == 1
    assert len(admin.get_policy(policy["id"])["versions"]) == 1

    evaluation = admin.evaluate_policy(
        world["session"]["id"],
        {"name": "stripe.refund"},
        payload_summary={"amountUsd": 2000},
        agent_id=world["agent"]["id"],
    )
    assert evaluation["decision"] == "deny"
    usage = admin.check_usage("stripe.refund", estimated_cost_usd=1)
    assert usage["allowed"] is True

    created = admin.create_audit_event("sdk.test", "system", payload={"source": "pytest"})
    assert created["eventType"] == "sdk.test"
    seen, cursor, pages = [], None, 0
    while True:
        page = admin.list_audit_events(cursor=cursor, limit=2)
        seen += [item["id"] for item in page["items"]]
        pages += 1
        cursor = page["cursor"]
        if not cursor or pages > 100:
            break
    assert pages > 1
    assert created["id"] in seen
    assert len(seen) == len(set(seen))

    hook = admin.create_webhook("https://93.184.216.34/toolguard", ["sdk.never"], secret="s3cret")
    assert hook["secret"] != "s3cret"
    assert hook["id"] in [item["id"] for item in admin.list_webhooks()]
    admin.delete_webhook(hook["id"])
    assert hook["id"] not in [item["id"] for item in admin.list_webhooks()]


def test_langchain_handler_against_server(world: Dict[str, Any]) -> None:
    pytest.importorskip("langchain_core")
    from langchain_core.tools import tool

    from toolguard.langchain import ToolGuardCallbackHandler, ToolMapping

    ran = []

    @tool
    def refund(amount_usd: float) -> str:
        """Refund a payment."""
        ran.append(amount_usd)
        return "ok"

    handler = ToolGuardCallbackHandler(
        world["runtime"],
        world["session"]["id"],
        tool_map={
            "refund": ToolMapping(name="stripe.refund", payload_summary=lambda args: {"amountUsd": args["amount_usd"]})
        },
    )
    with pytest.raises(ToolCallDenied):
        refund.invoke({"amount_usd": 9000}, config={"callbacks": [handler]})
    with pytest.raises(ApprovalRequired) as info:
        refund.invoke({"amount_usd": 20}, config={"callbacks": [handler]})
    assert info.value.approval_id
    assert ran == []
