"""PostgreSQL models for durable BoMesh domain state (``design.dbml``).

Canonical knowledge and authorization live here. Original bytes remain in
object storage; chunks and retrieval representations remain in Qdrant.
"""

from bomesh.db.models import lifecycle, triggers
from bomesh.db.models.assistant import (
    Artifact,
    ArtifactSourceItem,
    Conversation,
    EvidenceReviewCell,
    Message,
    MessageCitation,
    MessageItem,
    SandboxSession,
)
from bomesh.db.models.base import Base
from bomesh.db.models.collaboration import (
    Request,
    RequestMessage,
    RequestType,
    Space,
    SpaceAnnouncement,
    SpaceEvent,
    SpaceMaterial,
)
from bomesh.db.models.identity import (
    AccessSession,
    AuthIdentity,
    PasswordResetToken,
    User,
)
from bomesh.db.models.ingestion import (
    ExternalResource,
    IngestionPolicy,
    IngestionRun,
    IngestionRunItem,
    IngestionSource,
    IngestionSync,
    IntegrationConnection,
    IntegrationCredential,
    PlatformConnectorSettings,
)
from bomesh.db.models.knowledge import (
    Contribution,
    ContributionTopic,
    Item,
    ItemIndexState,
    ItemRevision,
    ItemShortcut,
    ItemTopic,
    ItemUpload,
    Topic,
    TopicCorrection,
    TopicCorrectionChange,
)
from bomesh.db.models.operations import (
    Operation,
    PlatformHealthCheck,
    RequestIdempotency,
)
from bomesh.db.models.shares import ResourceShare
from bomesh.db.models.workspaces import (
    AuditLog,
    Group,
    GroupMembership,
    KnowledgeGapDecision,
    Notification,
    Permission,
    RecentItem,
    Role,
    RoleAssignment,
    RolePermission,
    SavedItem,
    SavedSearch,
    Tenant,
    TenantMembership,
    WorkspaceAssistantSettings,
)

triggers.install(Base.metadata)
lifecycle.install()

__all__ = [
    "AccessSession",
    "Artifact",
    "ArtifactSourceItem",
    "AuditLog",
    "AuthIdentity",
    "Base",
    "Contribution",
    "ContributionTopic",
    "Conversation",
    "EvidenceReviewCell",
    "ExternalResource",
    "Group",
    "GroupMembership",
    "IngestionPolicy",
    "IngestionRun",
    "IngestionRunItem",
    "IngestionSource",
    "IngestionSync",
    "IntegrationConnection",
    "IntegrationCredential",
    "Item",
    "ItemIndexState",
    "ItemRevision",
    "ItemShortcut",
    "ItemTopic",
    "ItemUpload",
    "KnowledgeGapDecision",
    "Message",
    "MessageCitation",
    "MessageItem",
    "Notification",
    "Operation",
    "PasswordResetToken",
    "Permission",
    "PlatformConnectorSettings",
    "PlatformHealthCheck",
    "RecentItem",
    "Request",
    "RequestIdempotency",
    "RequestMessage",
    "RequestType",
    "ResourceShare",
    "Role",
    "RoleAssignment",
    "RolePermission",
    "SandboxSession",
    "SavedItem",
    "SavedSearch",
    "Space",
    "SpaceAnnouncement",
    "SpaceEvent",
    "SpaceMaterial",
    "Tenant",
    "TenantMembership",
    "Topic",
    "TopicCorrection",
    "TopicCorrectionChange",
    "User",
    "WorkspaceAssistantSettings",
]
