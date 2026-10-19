"""Webhook signature checks.

When a webhook has a secret, the server sends the header
``X-ToolGuard-Signature``. Its value is the lowercase hex HMAC-SHA256 of the
raw request body, keyed with the secret. There is no prefix and no timestamp.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Mapping, Optional, Union

SIGNATURE_HEADER = "X-ToolGuard-Signature"


def compute_webhook_signature(body: Union[bytes, str], secret: str) -> str:
    """Return the signature the server would send for ``body``."""
    raw = body.encode("utf-8") if isinstance(body, str) else body
    return hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()


def verify_webhook_signature(
    body: Union[bytes, str],
    signature: Optional[str],
    secret: str,
) -> bool:
    """Check an ``X-ToolGuard-Signature`` value against the raw body.

    Pass the body exactly as received. Re-serializing parsed JSON changes the
    bytes and the check fails. Comparison is constant-time.
    """
    if not signature or not secret:
        return False
    expected = compute_webhook_signature(body, secret)
    return hmac.compare_digest(expected, signature.strip().lower())


def signature_from_headers(headers: Mapping[str, str]) -> Optional[str]:
    """Read the signature header from a mapping, ignoring case."""
    wanted = SIGNATURE_HEADER.lower()
    for key, value in headers.items():
        if key.lower() == wanted:
            return value
    return None
