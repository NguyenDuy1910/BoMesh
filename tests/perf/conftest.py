"""Reuse the API harness fixtures of ``tests/v1`` (``client``, ``sessions``, ...).

``tests/v1/conftest.py`` is loaded under a private module name so its fixtures
register here too; the root ``tests/conftest.py`` already puts ``tests/v1`` on
``sys.path`` for ``harness`` and ``fakes``.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "_v1_conftest", Path(__file__).resolve().parents[1] / "v1" / "conftest.py"
)
assert _spec is not None and _spec.loader is not None
_v1 = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _v1  # dataclasses resolve their module by name
_spec.loader.exec_module(_v1)
database = _v1.database
sessions = _v1.sessions
fakes = _v1.fakes
runtime = _v1.runtime
app = _v1.app
client = _v1.client
world = _v1.world
