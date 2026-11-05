"""Provider-neutral navigation targets for grounded citations."""

from urllib.parse import urlsplit, urlunsplit

from bomesh.connector.protocol import CitationInfo, SourceIdentity


class CitationResolver:
    """Resolve a citation into its native source URL (the passage name is the internal target)."""

    @staticmethod
    def original_url(source: SourceIdentity, citation: CitationInfo) -> str | None:
        if not source.url:
            return None
        if not citation.anchor:
            return source.url
        parts = urlsplit(source.url)
        anchor = citation.anchor.removeprefix("#")
        return urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, anchor))


__all__ = ["CitationResolver"]
