"""BoMesh source adapters and validated ingestion hand-off contracts.

Each sub-package (confluence, jira, file, google_drive) implements the connector
contracts defined in ``connector.base`` and produces canonical items defined in
``bomesh.connector.protocol``.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from .base import BaseSourceConnector

ConnectorFactory = Callable[
    [Mapping[str, Any], Mapping[str, Any], Mapping[str, Any]],
    BaseSourceConnector,
]


#: How a connection of a connector is authorized: ``oauth`` (a provider grant),
#: ``api_token`` (a secret entered once) or ``none``.
AuthenticationType = Literal["oauth", "api_token", "none"]


@dataclass(frozen=True, slots=True)
class ConnectorDefinition:
    """One entry of the platform connector catalog; never persisted as tenant data.

    A definition without a ``factory`` is listed in the catalog but cannot be
    connected (``Connector.state`` UNSUPPORTED). ``authentication_type`` is
    the catalog's way of connecting; ``accepts_api_token`` lets an ``oauth``
    connector also be connected with an API token (a Confluence site without
    an Atlassian authorization). ``config_keys`` are the ``Connection.config``
    keys a token-authorized connection takes, ``required_config_keys`` the
    ones it must set; an OAuth grant writes its own configuration.
    """

    key: str
    display_name: str
    description: str
    authentication_type: AuthenticationType
    factory: ConnectorFactory | None = None
    accepts_api_token: bool = False
    config_keys: frozenset[str] = frozenset()
    required_config_keys: frozenset[str] = frozenset()

    @property
    def supported(self) -> bool:
        return self.factory is not None

    @property
    def takes_api_token(self) -> bool:
        return self.authentication_type == "api_token" or self.accepts_api_token


from .adapter import CheckpointedSourceConnectorAdapter
from .pipeline import ConnectorPipeline, ConnectorPipelineConfig
from bomesh.connector.protocol import AnyContentPart, AnyItem, ItemChange

__all__ = [
    "AuthenticationType",
    "ConnectorPipeline",
    "ConnectorPipelineConfig",
    "ConnectorDefinition",
    "ConnectorFactory",
    "CheckpointedSourceConnectorAdapter",
    "AnyContentPart",
    "AnyItem",
    "ItemChange",
]
