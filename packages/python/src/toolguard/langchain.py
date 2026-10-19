"""LangChain integration.

Install with ``pip install "toolguard[langchain]"``.

ToolGuardCallbackHandler authorizes every tool call in ``on_tool_start``.
If ToolGuard denies the call it raises ToolCallDenied. If the call needs a
human approval it raises ApprovalRequired, or, with ``wait_for_approval=True``,
blocks until the approval is resolved and then re-authorizes. The handler sets
``raise_error = True`` so LangChain lets these exceptions stop the tool.

Use AsyncToolGuardCallbackHandler with async tools. LangChain runs a sync
tool's callbacks on the sync path, where it logs and drops exceptions from
async handlers, so an async handler cannot block a sync tool. For sync tools,
use ToolGuardCallbackHandler.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Union
from uuid import UUID

try:
    from langchain_core.callbacks import AsyncCallbackHandler, BaseCallbackHandler
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        'toolguard.langchain needs langchain-core. Install it with: pip install "toolguard[langchain]"'
    ) from exc

from ._async_client import AsyncToolGuard
from ._client import ToolGuard
from .errors import ApprovalRequired, ToolCallDenied
from .types import AuthorizationDecision, ToolInput


@dataclass
class ToolMapping:
    """How a LangChain tool maps to a ToolGuard tool.

    ``name`` is the ToolGuard catalog name (for example "stripe.refund").
    ``context`` and ``payload_summary`` can be dicts or functions that take the
    tool input (a dict when LangChain passes structured inputs, otherwise the
    raw input string).
    """

    name: str
    action: Optional[str] = None
    resource: Optional[str] = None
    context: Union[Mapping[str, Any], Callable[[Any], Mapping[str, Any]], None] = None
    payload_summary: Union[Mapping[str, Any], Callable[[Any], Mapping[str, Any]], None] = None

    def tool_input(self) -> ToolInput:
        tool: ToolInput = {"name": self.name}
        if self.action:
            tool["action"] = self.action
        if self.resource:
            tool["resource"] = self.resource
        return tool

    def build_context(self, tool_args: Any) -> Dict[str, Any]:
        return _resolve(self.context, tool_args)

    def build_payload_summary(self, tool_args: Any) -> Dict[str, Any]:
        return _resolve(self.payload_summary, tool_args)


ToolMap = Mapping[str, Union[str, ToolMapping]]


def _resolve(value: Any, tool_args: Any) -> Dict[str, Any]:
    if value is None:
        return {}
    if callable(value):
        return dict(value(tool_args))
    return dict(value)


class _HandlerCore:
    def __init__(
        self,
        session_id: str,
        tool_map: Optional[ToolMap],
        run_id: Optional[str],
        wait_for_approval: bool,
        approval_timeout: float,
        poll_interval: float,
        unmapped: str,
    ) -> None:
        if unmapped not in ("authorize", "skip"):
            raise ValueError('unmapped must be "authorize" or "skip"')
        self.session_id = session_id
        self.tool_map = dict(tool_map or {})
        self.toolguard_run_id = run_id
        self.wait_for_approval = wait_for_approval
        self.approval_timeout = approval_timeout
        self.poll_interval = poll_interval
        self.unmapped = unmapped
        self.decisions: Dict[UUID, AuthorizationDecision] = {}

    def mapping_for(self, serialized: Optional[Dict[str, Any]], kwargs: Mapping[str, Any]) -> Optional[ToolMapping]:
        name = (serialized or {}).get("name") or kwargs.get("name")
        if not name:
            name = "unknown_tool"
        entry = self.tool_map.get(name)
        if entry is None:
            return None if self.unmapped == "skip" else ToolMapping(name=name)
        if isinstance(entry, str):
            return ToolMapping(name=entry)
        return entry

    @staticmethod
    def tool_args(input_str: str, inputs: Optional[Dict[str, Any]]) -> Any:
        return inputs if inputs is not None else input_str

    @staticmethod
    def check(mapping: ToolMapping, decision: AuthorizationDecision) -> None:
        if decision.allowed:
            return
        if decision.denied:
            raise ToolCallDenied(mapping.name, decision)
        raise ApprovalRequired(mapping.name, decision)


class ToolGuardCallbackHandler(BaseCallbackHandler):
    """Authorize LangChain tool calls with ToolGuard (sync).

    ``tool_map`` maps LangChain tool names to ToolGuard tool names or
    ToolMapping objects. A tool that is not in the map is authorized under its
    LangChain name, unless ``unmapped="skip"``.
    """

    raise_error = True

    def __init__(
        self,
        client: ToolGuard,
        session_id: str,
        *,
        tool_map: Optional[ToolMap] = None,
        run_id: Optional[str] = None,
        wait_for_approval: bool = False,
        approval_timeout: float = 300.0,
        poll_interval: float = 2.0,
        unmapped: str = "authorize",
    ) -> None:
        super().__init__()
        self.client = client
        self._core = _HandlerCore(
            session_id, tool_map, run_id, wait_for_approval, approval_timeout, poll_interval, unmapped
        )

    @property
    def decisions(self) -> Dict[UUID, AuthorizationDecision]:
        """The last decision per LangChain run id."""
        return self._core.decisions

    def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        inputs: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        core = self._core
        mapping = core.mapping_for(serialized, kwargs)
        if mapping is None:
            return
        tool_args = core.tool_args(input_str, inputs)
        context = mapping.build_context(tool_args)
        payload_summary = mapping.build_payload_summary(tool_args)
        decision = self.client.authorize(
            core.session_id,
            mapping.tool_input(),
            context=context,
            payload_summary=payload_summary,
            run_id=core.toolguard_run_id,
            invocation_id=str(run_id),
        )
        if decision.pending_approval and core.wait_for_approval and decision.approval_id:
            decision = self.client.wait_for_approval(
                decision.approval_id,
                core.session_id,
                mapping.tool_input(),
                context=context,
                payload_summary=payload_summary,
                run_id=core.toolguard_run_id,
                invocation_id=str(run_id),
                timeout=core.approval_timeout,
                poll_interval=core.poll_interval,
            )
        core.decisions[run_id] = decision
        core.check(mapping, decision)


class AsyncToolGuardCallbackHandler(AsyncCallbackHandler):
    """Async version of ToolGuardCallbackHandler, for AsyncToolGuard and async agents."""

    raise_error = True

    def __init__(
        self,
        client: AsyncToolGuard,
        session_id: str,
        *,
        tool_map: Optional[ToolMap] = None,
        run_id: Optional[str] = None,
        wait_for_approval: bool = False,
        approval_timeout: float = 300.0,
        poll_interval: float = 2.0,
        unmapped: str = "authorize",
    ) -> None:
        super().__init__()
        self.client = client
        self._core = _HandlerCore(
            session_id, tool_map, run_id, wait_for_approval, approval_timeout, poll_interval, unmapped
        )

    @property
    def decisions(self) -> Dict[UUID, AuthorizationDecision]:
        return self._core.decisions

    async def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        inputs: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        core = self._core
        mapping = core.mapping_for(serialized, kwargs)
        if mapping is None:
            return
        tool_args = core.tool_args(input_str, inputs)
        context = mapping.build_context(tool_args)
        payload_summary = mapping.build_payload_summary(tool_args)
        decision = await self.client.authorize(
            core.session_id,
            mapping.tool_input(),
            context=context,
            payload_summary=payload_summary,
            run_id=core.toolguard_run_id,
            invocation_id=str(run_id),
        )
        if decision.pending_approval and core.wait_for_approval and decision.approval_id:
            decision = await self.client.wait_for_approval(
                decision.approval_id,
                core.session_id,
                mapping.tool_input(),
                context=context,
                payload_summary=payload_summary,
                run_id=core.toolguard_run_id,
                invocation_id=str(run_id),
                timeout=core.approval_timeout,
                poll_interval=core.poll_interval,
            )
        core.decisions[run_id] = decision
        core.check(mapping, decision)


__all__ = [
    "AsyncToolGuardCallbackHandler",
    "ToolGuardCallbackHandler",
    "ToolMap",
    "ToolMapping",
]
