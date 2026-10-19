from __future__ import annotations

from typing import Iterator

import pytest
import respx

BASE = "http://toolguard.test"


@pytest.fixture
def mock_api() -> Iterator[respx.MockRouter]:
    with respx.mock(base_url=BASE, assert_all_called=False) as router:
        yield router
