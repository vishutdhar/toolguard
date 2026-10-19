"""Exceptions raised by the ToolGuard client."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, Optional

if TYPE_CHECKING:
    from .types import AuthorizationDecision


class ToolGuardError(Exception):
    """An error returned by the ToolGuard API, or raised by the client.

    ``code`` is the API's ``error`` field (for example ``CAPABILITY_REQUIRED``)
    and ``details`` is its ``details`` field, when present.
    """

    def __init__(
        self,
        message: str,
        status_code: int,
        code: str,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.details = details

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(message={self.message!r}, status_code={self.status_code!r}, "
            f"code={self.code!r}, details={self.details!r})"
        )


class ToolCallBlocked(ToolGuardError):
    """Base class for a tool call that ToolGuard did not allow."""

    def __init__(self, message: str, code: str, decision: "AuthorizationDecision") -> None:
        super().__init__(
            message,
            status_code=403,
            code=code,
            details={
                "decision": decision.decision,
                "reasonCodes": list(decision.reason_codes),
                "approvalId": decision.approval_id,
            },
        )
        self.decision = decision


class ToolCallDenied(ToolCallBlocked):
    """ToolGuard denied the tool call."""

    def __init__(self, tool_name: str, decision: "AuthorizationDecision") -> None:
        reasons = ", ".join(decision.reason_codes) or "no reason codes"
        super().__init__(f"ToolGuard denied {tool_name}: {reasons}", "TOOL_CALL_DENIED", decision)
        self.tool_name = tool_name


class ApprovalRequired(ToolCallBlocked):
    """The tool call needs a human approval before it can run."""

    def __init__(self, tool_name: str, decision: "AuthorizationDecision") -> None:
        super().__init__(
            f"ToolGuard requires approval for {tool_name} (approval {decision.approval_id})",
            "APPROVAL_REQUIRED",
            decision,
        )
        self.tool_name = tool_name
        self.approval_id = decision.approval_id


class ApprovalTimeout(ToolGuardError):
    """wait_for_approval gave up before the approval was resolved."""

    def __init__(self, approval_id: str, timeout: float) -> None:
        super().__init__(
            f"Approval {approval_id} was still pending after {timeout} seconds",
            status_code=408,
            code="APPROVAL_TIMEOUT",
            details={"approvalId": approval_id, "timeout": timeout},
        )
        self.approval_id = approval_id
