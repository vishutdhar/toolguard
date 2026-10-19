"""Pieces shared by the sync and async clients."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

import httpx

from .errors import ToolGuardError

DEFAULT_BASE_URL = "http://localhost:3000"
DEFAULT_TIMEOUT = 30.0
USER_AGENT = "toolguard-python"


@dataclass(frozen=True)
class ClientConfig:
    api_key: Optional[str]
    base_url: str
    org_id: Optional[str]
    agent_id: Optional[str]

    def url(self, path: str) -> str:
        return self.base_url.rstrip("/") + path

    def headers(self) -> Dict[str, str]:
        headers = {"accept": "application/json", "user-agent": USER_AGENT}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        return headers

    def require_org(self, override: Optional[str]) -> str:
        org_id = override or self.org_id
        if not org_id:
            raise ToolGuardError(
                "org_id is required: pass it to the call or to the ToolGuard constructor",
                400,
                "MISSING_ORG_ID",
            )
        return org_id

    def require_agent(self, override: Optional[str]) -> str:
        agent_id = override or self.agent_id
        if not agent_id:
            raise ToolGuardError(
                "agent_id is required: pass it to the call or to the ToolGuard constructor",
                400,
                "MISSING_AGENT_ID",
            )
        return agent_id


def compact(params: Mapping[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in params.items() if value is not None}


def handle_response(response: httpx.Response, method: str, path: str) -> Any:
    if response.status_code == 204 or not response.content:
        if response.is_success:
            return None
        raise ToolGuardError(
            f"{method} {path} failed with status {response.status_code}",
            response.status_code,
            "UNKNOWN_ERROR",
        )

    try:
        body = response.json()
    except ValueError:
        raise ToolGuardError(
            f"Unexpected response from {method} {path}: {response.status_code} {response.reason_phrase}",
            response.status_code,
            "INVALID_RESPONSE",
        ) from None

    if not response.is_success:
        if isinstance(body, dict):
            details = body.get("details")
            raise ToolGuardError(
                str(body.get("message") or response.reason_phrase),
                response.status_code,
                str(body.get("error") or "UNKNOWN_ERROR"),
                details if isinstance(details, dict) else None,
            )
        raise ToolGuardError(str(body), response.status_code, "UNKNOWN_ERROR")

    return body
