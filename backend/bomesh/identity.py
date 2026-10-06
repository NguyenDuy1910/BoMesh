"""The namespace of every identity BoMesh derives and then stores.

Upload, collection, external-resource and ingestion identifiers are uuid5
values of ``"{namespace}:{kind}:…"`` names, and connection credentials are
encrypted with ``"{namespace}:plugin-credential:{id}"`` as associated data.
Those values are persisted, so the namespace is a data format, not branding:
it keeps the name the platform was first deployed under. Changing it re-keys
every stored identity (each user's personal collection appears empty, a sync
duplicates every connector document) and makes every stored credential
undecryptable.
"""

PERSISTED_IDENTITY_NAMESPACE = "bothesis"

__all__ = ["PERSISTED_IDENTITY_NAMESPACE"]
