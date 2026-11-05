"""Fixtures of the KnowledgeItems slice tests."""

from __future__ import annotations

import pytest

from bomesh.runtime import AppRuntime
from harness import Fakes, Sessions
from knowledge_support import Knowledge


@pytest.fixture
def knowledge(runtime: AppRuntime, sessions: Sessions, fakes: Fakes) -> Knowledge:
    return Knowledge(runtime, sessions, fakes)
