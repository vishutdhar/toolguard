# ToolGuard Python SDK

Python client for [ToolGuard](https://github.com/vishutdhar/toolguard). Your agent asks ToolGuard before each tool call, a human approves the risky ones, and every decision lands in the audit log.

It covers the same API as the TypeScript `@toolguard/client`, with a sync client (`ToolGuard`), an async client (`AsyncToolGuard`), webhook signature checks, and an optional LangChain callback handler.

## Install

The package is not on PyPI yet. Install it from the repo:

```bash
pip install "toolguard @ git+https://github.com/vishutdhar/toolguard#subdirectory=packages/python"

# with the LangChain handler
pip install "toolguard[langchain] @ git+https://github.com/vishutdhar/toolguard#subdirectory=packages/python"
```

It needs Python 3.10 or newer and depends on `httpx`.

## Quickstart

```python
from toolguard import ToolGuard

# Self-signup returns an org and a full access key.
boot = ToolGuard(base_url="http://localhost:3000").bootstrap("Acme")
admin = ToolGuard(
    api_key=boot["rawApiKey"],
    base_url="http://localhost:3000",
    org_id=boot["organization"]["id"],
)

agent = admin.create_agent("support-agent", "production")
admin.create_tool("stripe.refund", "refund", "stripe", "high")
session = admin.create_session(agent_id=agent["id"], scopes=["stripe:refund"])

# Give the agent a key that can authorize tool calls but cannot approve them.
agent_key = admin.create_api_key("agent-runtime", scopes=["tool:authorize"])["rawApiKey"]
tg = ToolGuard(api_key=agent_key, org_id=boot["organization"]["id"], agent_id=agent["id"])

decision = tg.authorize(
    session["id"],
    {"name": "stripe.refund"},
    payload_summary={"amountUsd": 40},
)

if decision.allowed:
    ...  # run the refund
elif decision.pending_approval:
    print("waiting for a human:", decision.approval_id)
else:
    print("denied:", decision.reason_codes)
```

`authorize()` returns an `AuthorizationDecision` with `allowed`, `denied` and `pending_approval`, plus `reason_codes`, `approval_id`, `limits` and the full response in `raw`. Other methods return the API's JSON as dicts with camelCase keys.

## Waiting for an approval

On `require_approval` the server creates an approval. A key with the `approvals:resolve` capability (a person, or your dashboard) approves or rejects it:

```python
admin.approve(decision.approval_id)  # or admin.reject(...)
```

The agent can block until that happens and then authorize again:

```python
final = tg.wait_for_approval(
    decision.approval_id,
    session["id"],
    {"name": "stripe.refund"},
    payload_summary={"amountUsd": 40},
    timeout=300,
)
```

Pass the same session, tool, context and payload summary as the first call. The helper polls `GET /v1/approvals/{id}` every `poll_interval` seconds, then calls `authorize()` with the approval id and an `invocation_id`. Leave `invocation_id` out and it uses a new UUID. Reusing an invocation id makes a retry idempotent: the approval is consumed once. An approved request comes back as `allow` and a rejected one as `deny`. If the approval is still pending at the timeout, it raises `ApprovalTimeout`.

## Async

`AsyncToolGuard` has the same methods, awaited:

```python
from toolguard import AsyncToolGuard

async with AsyncToolGuard(api_key=key, org_id=org_id, agent_id=agent_id) as tg:
    decision = await tg.authorize(session_id, {"name": "slack.post_message"})
```

## LangChain

`ToolGuardCallbackHandler` authorizes each tool call in `on_tool_start`. A denied call raises `ToolCallDenied` and a call that needs approval raises `ApprovalRequired`, so the tool body never runs.

```python
from langchain_core.tools import tool
from toolguard.langchain import ToolGuardCallbackHandler, ToolMapping


@tool
def issue_refund(payment_id: str, amount_usd: float) -> str:
    """Refund a payment."""
    ...


handler = ToolGuardCallbackHandler(
    tg,
    session_id,
    tool_map={
        "issue_refund": ToolMapping(
            name="stripe.refund",
            payload_summary=lambda args: {"amountUsd": args["amount_usd"]},
        ),
    },
)

issue_refund.invoke({"payment_id": "pi_1", "amount_usd": 40}, config={"callbacks": [handler]})
```

Notes:

- `tool_map` maps LangChain tool names to ToolGuard tool names, as a plain string or a `ToolMapping` with `context` and `payload_summary` (dicts or functions of the tool input). A tool missing from the map is authorized under its own name. Pass `unmapped="skip"` to let it through instead.
- `wait_for_approval=True` makes the handler block on pending approvals and run the tool once it is approved.
- The LangChain run id is sent as the `invocationId`.
- `AsyncToolGuardCallbackHandler` works with `AsyncToolGuard` and async tools. LangChain drops exceptions from async handlers when it runs a sync tool, so use the sync handler for sync tools.

## Webhooks

If a webhook has a secret, each delivery has an `X-ToolGuard-Signature` header: the hex HMAC-SHA256 of the raw body, keyed with the secret.

```python
from toolguard import signature_from_headers, verify_webhook_signature

ok = verify_webhook_signature(raw_body, signature_from_headers(request.headers), secret)
```

Pass the body bytes exactly as received.

## Errors

API errors raise `ToolGuardError` with `status_code`, `code` (the API's `error` field, for example `CAPABILITY_REQUIRED` or `SCOPE_ESCALATION`), `message` and `details`. `ToolCallDenied`, `ApprovalRequired` and `ApprovalTimeout` are subclasses.

## Endpoints

| Method | Endpoint |
|---|---|
| `health()` | `GET /healthz` |
| `bootstrap()` | `POST /v1/organizations` |
| `create_api_key()` | `POST /v1/api-keys` |
| `create_agent()`, `list_agents()` | `/v1/agents` |
| `create_session()` | `POST /v1/sessions` |
| `create_tool()`, `list_tools()` | `/v1/tools` |
| `create_policy()`, `get_policy()`, `create_policy_version()` | `/v1/policies` |
| `evaluate_policy()` | `POST /v1/policy/evaluate` |
| `check_usage()` | `POST /v1/usage/check` |
| `authorize()`, `wait_for_approval()` | `POST /v1/tool/authorize` |
| `request_approval()`, `get_approval()`, `list_approvals()`, `resolve_approval()`, `approve()`, `reject()` | `/v1/approvals` |
| `create_audit_event()`, `list_audit_events()` | `/v1/audit/events` |
| `create_run()`, `complete_run()`, `replay()` | `/v1/runs` |
| `create_webhook()`, `list_webhooks()`, `delete_webhook()` | `/v1/webhooks` |

## Development

```bash
cd packages/python
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest
```

The integration tests start the real server in memory mode from `dist/src/server.js`, so run `npm ci && npm run build` at the repo root first, or they skip. `_async_client.py` is generated from `_client.py`: edit the sync client, then run `python scripts/gen_async.py`.
