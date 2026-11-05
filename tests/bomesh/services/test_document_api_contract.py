"""Persistence guard: stored bytes and index points are purged only at the boundaries.

Row deletes of tombstoned tables are refused at runtime by every ORM session
(``bomesh.db.models.lifecycle``; tested in ``tests/v1/db``). Object-storage
and index deletes exist only behind the documented purge boundaries.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from config.env_config import boolean as _environment_boolean

BACKEND = Path(__file__).resolve().parents[3] / "backend" / "bomesh"
# Physical deletes of stored bytes and index points: the purge after
# ``purgeTime`` (item_model.md §7), behind the storage and index adapters.
PURGE_BOUNDARIES = {
    "storage/aws_s3.py": "delete_object(",
    "document_index/_qdrant.py": ".client.delete(",
}


def _sources() -> list[tuple[str, str]]:
    return [
        (str(path.relative_to(BACKEND)), path.read_text(encoding="utf-8"))
        for path in BACKEND.rglob("*.py")
    ]


def test_stored_objects_and_index_points_are_purged_only_at_the_boundaries() -> None:
    offenders = [
        f"{path}: {operation}"
        for path, source in _sources()
        for operation in ("delete_object(", ".client.delete(")
        if operation in source and PURGE_BOUNDARIES.get(path) != operation
    ]
    assert offenders == []


def test_environment_boolean_requires_a_json_boolean(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    setting_name = "BOMESH_TEST_BOOLEAN"
    monkeypatch.delenv(setting_name, raising=False)
    assert _environment_boolean(setting_name) is False

    monkeypatch.setenv(setting_name, json.dumps(True))
    assert _environment_boolean(setting_name) is True

    monkeypatch.setenv(setting_name, json.dumps({"enabled": True}))
    with pytest.raises(RuntimeError, match="must be a JSON boolean"):
        _environment_boolean(setting_name)
