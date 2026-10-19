from __future__ import annotations

import hashlib
import hmac
import json

from toolguard import compute_webhook_signature, signature_from_headers, verify_webhook_signature

BODY = json.dumps(
    {"eventType": "approval.requested", "payload": {"id": "ap_1"}, "timestamp": "2026-01-01T00:00:00.000Z"}
)


def test_matches_server_format() -> None:
    # Server: createHmac("sha256", secret).update(body).digest("hex")
    expected = hmac.new(b"s3cret", BODY.encode(), hashlib.sha256).hexdigest()
    assert compute_webhook_signature(BODY, "s3cret") == expected
    assert compute_webhook_signature(BODY.encode(), "s3cret") == expected


def test_verify_accepts_valid_and_rejects_tampering() -> None:
    sig = compute_webhook_signature(BODY, "s3cret")
    assert verify_webhook_signature(BODY, sig, "s3cret")
    assert verify_webhook_signature(BODY.encode(), sig.upper(), "s3cret")
    assert not verify_webhook_signature(BODY + " ", sig, "s3cret")
    assert not verify_webhook_signature(BODY, sig, "other")
    assert not verify_webhook_signature(BODY, None, "s3cret")
    assert not verify_webhook_signature(BODY, "", "s3cret")
    assert not verify_webhook_signature(BODY, sig, "")


def test_header_lookup_ignores_case() -> None:
    assert signature_from_headers({"x-toolguard-signature": "abc"}) == "abc"
    assert signature_from_headers({"X-ToolGuard-Signature": "abc"}) == "abc"
    assert signature_from_headers({"content-type": "application/json"}) is None
