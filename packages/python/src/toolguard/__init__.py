"""Python client for ToolGuard: human approval and an audit log for AI agent tool calls."""

from ._async_client import AsyncToolGuard
from ._client import ToolGuard
from .errors import ApprovalRequired, ApprovalTimeout, ToolCallBlocked, ToolCallDenied, ToolGuardError
from .types import AuthorizationDecision
from .webhooks import SIGNATURE_HEADER, compute_webhook_signature, signature_from_headers, verify_webhook_signature

__version__ = "0.1.0"

__all__ = [
    "SIGNATURE_HEADER",
    "ApprovalRequired",
    "ApprovalTimeout",
    "AsyncToolGuard",
    "AuthorizationDecision",
    "ToolCallBlocked",
    "ToolCallDenied",
    "ToolGuard",
    "ToolGuardError",
    "__version__",
    "compute_webhook_signature",
    "signature_from_headers",
    "verify_webhook_signature",
]
