"""Fixtures of the Workspaces API tests."""

from __future__ import annotations

import pytest

from harness import Sessions
from workspaces_support import Conversations


@pytest.fixture
def conversations(sessions: Sessions) -> Conversations:
    return Conversations(sessions)
