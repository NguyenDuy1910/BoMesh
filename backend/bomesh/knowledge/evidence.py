"""Provider-neutral navigation targets for grounded citations."""

from bomesh.connector.protocol import SourceIdentity


class CitationResolver:
    """Resolve a cited document into its native source URL.

    The internal target of a citation is its ``CitationTarget`` (blocks of the
    item's Structured Document); this is only the link to the original system.
    """

    @staticmethod
    def original_url(source: SourceIdentity) -> str | None:
        return source.url or None


__all__ = ["CitationResolver"]
