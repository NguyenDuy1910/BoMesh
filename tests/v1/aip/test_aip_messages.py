"""Proto3 JSON mapping: camelCase, omitted unset fields, int64 strings, RFC 3339 times."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.aip.messages import FieldMaskStr, Int64, ProtoMessage, Timestamp


class Usage(ProtoMessage):
    size_bytes: Int64
    quota_bytes: Int64 | None = None


class Resource(ProtoMessage):
    display_name: str | None = None
    create_time: Timestamp | None = None
    usage: Usage | None = None


class Patch(ProtoMessage):
    update_mask: FieldMaskStr


def test_int64_round_trips_as_a_json_string() -> None:
    big = 2**63 - 1

    from_string = Usage.model_validate_json(f'{{"sizeBytes": "{big}"}}')
    from_number = Usage.model_validate_json(f'{{"sizeBytes": {big}}}')

    assert from_string.size_bytes == from_number.size_bytes == big
    assert from_string.model_dump_json() == f'{{"sizeBytes":"{big}"}}'
    assert Usage.model_validate_json(from_string.model_dump_json()) == from_string


@pytest.mark.parametrize(
    "value",
    [
        '"9223372036854775808"',
        '"-9223372036854775809"',
        '"12.5"',
        "12.5",
        '"1e3"',
        "true",
        '""',
    ],
)
def test_int64_rejects_non_int64_values(value: str) -> None:
    with pytest.raises(ValidationError):
        Usage.model_validate_json(f'{{"sizeBytes": {value}}}')


def test_int64_accepts_the_minimum() -> None:
    assert Usage.model_validate({"sizeBytes": "-9223372036854775808"}).size_bytes == -(
        2**63
    )


def test_timestamp_is_normalized_to_utc_with_z() -> None:
    resource = Resource.model_validate({"createTime": "2026-11-04T09:30:00.250+02:00"})

    assert resource.create_time == datetime(2026, 11, 4, 7, 30, 0, 250000, tzinfo=UTC)
    assert resource.model_dump_json() == '{"createTime":"2026-11-04T07:30:00.250000Z"}'


def test_naive_timestamp_input_is_rejected_but_naive_output_is_utc() -> None:
    with pytest.raises(ValidationError):
        Resource.model_validate({"createTime": "2026-11-04T09:30:00"})

    naive = Resource.model_construct(create_time=datetime(2026, 11, 4, 9, 30))
    assert naive.model_dump_json() == '{"createTime":"2026-11-04T09:30:00Z"}'


def test_unset_and_null_fields_are_omitted_at_every_level() -> None:
    resource = Resource(display_name="Policy", usage=Usage(size_bytes=1))

    assert resource.model_dump(mode="json") == {
        "displayName": "Policy",
        "usage": {"sizeBytes": "1"},
    }


def test_snake_case_names_are_accepted_but_unknown_fields_are_not() -> None:
    assert Resource.model_validate({"display_name": "A"}).display_name == "A"
    with pytest.raises(ValidationError):
        Resource.model_validate({"displayName": "A", "colour": "red"})


def test_field_mask_string_is_checked_and_normalized() -> None:
    assert Patch.model_validate(
        {"updateMask": "displayName, collection.description"}
    ).update_mask == ("displayName,collection.description")
    assert Patch.model_validate({"updateMask": "*"}).update_mask == "*"
    for bad in ("display_name", "displayName,", "a..b", "*,displayName"):
        with pytest.raises(ValidationError):
            Patch.model_validate({"updateMask": bad})


def test_fastapi_serializes_and_documents_messages_in_proto3_json() -> None:
    app = FastAPI()

    @app.get("/resource", response_model=Resource)
    def get_resource() -> Resource:
        return Resource(display_name="A", usage=Usage(size_bytes=2**40))

    client = TestClient(app)

    assert client.get("/resource").json() == {
        "displayName": "A",
        "usage": {"sizeBytes": str(2**40)},
    }
    schemas = client.get("/openapi.json").json()["components"]["schemas"]
    assert "displayName" in schemas["Resource"]["properties"]
    assert schemas["Usage"]["properties"]["sizeBytes"] == {
        "type": "string",
        "format": "int64",
        "title": "Sizebytes",
    }
