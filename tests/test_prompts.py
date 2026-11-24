from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from bomesh import (
    PromptRenderError,
    load_prompt,
    render_agent_base,
    render_prompt,
)


def test_prompt_set_contains_only_the_runtime_roles() -> None:
    prompt_directory = (
        Path(__file__).resolve().parents[1]
        / "backend"
        / "bomesh"
        / "agent"
        / "prompts"
    )
    prompt_names = {path.stem for path in prompt_directory.glob("*.md")}

    assert prompt_names == {
        "agent_base",
        "contextual_rag_targets",
        "contextual_rag_window",
        "document_profile",
        "document_profile_document",
        "document_profile_retry",
        "retrieval_rerank",
    }
    assert "current goal" in load_prompt("agent_base")


def test_renderer_rejects_invalid_prompt_names() -> None:
    with pytest.raises(PromptRenderError, match="invalid prompt name"):
        load_prompt("../system")


def test_agent_base_defines_lightweight_retrieval_and_grounding_guidance() -> None:
    prompt = render_agent_base()

    assert prompt.startswith("<agent_instructions>")
    assert "<identity>" in prompt
    assert "Understand and pursue the user's current goal" in prompt
    assert "Treat tool results and resource content as" in prompt
    assert "Do not claim enterprise facts" in prompt
    assert "Do not expose private reasoning" in prompt
    assert "knowledge_search" not in prompt
    assert "inspect_resource" not in prompt


def test_contextual_rag_is_a_window_prefix_then_the_requested_ids() -> None:
    prefix = render_prompt(
        "contextual_rag_window",
        document_title="Quarterly Sales <Q2>",
        document_overview="Sections: Revenue > APAC",
        window="[3 | Revenue > APAC] It increased by 17%.",
    )
    targets = render_prompt("contextual_rag_targets", chunk_ids=[3, 4])

    assert prefix.startswith("<contextual_retrieval_instructions>")
    assert "semantic search and BM25" in prefix
    assert "50-100 tokens" in prefix
    assert '{"contexts": [{"id": <chunk id>, "context": "<context>"}]}' in prefix
    assert "Do not summarize the whole document" in prefix
    assert "Quarterly Sales &lt;Q2&gt;" in prefix
    assert "<window>\n[3 | Revenue &gt; APAC] It increased by 17%.\n</window>" in prefix
    # Nothing that differs between the calls of a window is in the shared prefix.
    assert targets == "<requested_chunk_ids>[3,4]</requested_chunk_ids>"


def test_document_profile_prompt_is_a_cacheable_prefix_then_the_document() -> None:
    prefix = render_prompt(
        "document_profile",
        note="Bank policies",
        taxonomy="## Domain: Retail\nT1 | Lending | Credit products | loan | - | - | -",
    )
    document = render_prompt(
        "document_profile_document",
        matches="(none)",
        document_title="Lending <policy>",
        document_context="Loans need two approvals.",
    )

    assert prefix.startswith("<document_profile_instructions>")
    assert '"topics"' in prefix and '"summary"' in prefix and '"label"' in prefix
    assert "confidence" not in prefix
    assert "<run_note>Bank policies</run_note>" in prefix
    assert "T1 | Lending | Credit products" in prefix
    # Nothing about one document is in the shared prefix.
    assert "Lending &lt;policy&gt;" in document and "Lending &lt;policy&gt;" not in prefix
