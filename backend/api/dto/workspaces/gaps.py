"""KnowledgeGap messages, filters and order."""

from __future__ import annotations

from typing import Literal

from api.aip import filtering
from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.workspaces.knowledge_gaps import GAPS
from bomesh.services.workspaces.records import KnowledgeGapRecord

GapState = Literal["OPEN", "DISMISSED", "RESOLVED"]
GapReason = Literal["NOT_COVERED", "OUTDATED", "RATED_UNHELPFUL"]


class KnowledgeGapMessage(ProtoMessage):
    name: str
    question: str
    ask_count: int
    last_ask_time: Timestamp
    reason: GapReason
    suggested_collection: str | None = None
    state: GapState


class ListKnowledgeGapsResponse(ProtoMessage):
    knowledge_gaps: list[KnowledgeGapMessage]
    next_page_token: str | None = None


class KnowledgeGapTransitionRequest(ProtoMessage):
    """Empty body of ``:dismiss`` and ``:reopen``."""


def knowledge_gap_message(record: KnowledgeGapRecord) -> KnowledgeGapMessage:
    return KnowledgeGapMessage(
        name=record.name,
        question=record.question,
        ask_count=record.ask_count,
        last_ask_time=record.last_ask_time,
        reason=record.reason,  # type: ignore[arg-type]
        suggested_collection=(
            item_name(record.workspace_id, record.suggested_collection_id)
            if record.suggested_collection_id is not None
            else None
        ),
        state=record.state,  # type: ignore[arg-type]
    )


KNOWLEDGE_GAP_FILTERS = FilterSchema(
    {
        "state": filtering.enum(GAPS.c.state, ("OPEN", "DISMISSED", "RESOLVED")),
        "reason": filtering.enum(GAPS.c.reason, ("NOT_COVERED", "OUTDATED", "RATED_UNHELPFUL")),
        "lastAskTime": filtering.timestamp(GAPS.c.last_ask_time),
        "askCount": filtering.integer(GAPS.c.ask_count),
    }
)
KNOWLEDGE_GAP_ORDER = OrderSchema(
    {"askCount": GAPS.c.ask_count, "lastAskTime": GAPS.c.last_ask_time},
    tie_breaker=[GAPS.c.gap_key],
    default="askCount desc, lastAskTime desc",
)
