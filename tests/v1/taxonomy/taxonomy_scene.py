"""A workspace with an admin and a plain member, and taxonomy API shortcuts (fixture ``tx``)."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import select

from bomesh.db.models import (
    AuditLog,
    Concept,
    ConceptScheme,
    IngestionRun,
    IngestionRunItem,
    Item,
    ItemConcept,
    Tenant,
    User,
)
from bomesh.runtime import AppRuntime
from harness import ApiClient, Sessions, World


class TaxonomyScene:
    def __init__(self, client: ApiClient, world: World, sessions: Sessions, runtime: AppRuntime) -> None:
        self.client, self.world, self.sessions, self.runtime = client, world, sessions, runtime
        self.admin: User
        self.member: User
        self.ws: Tenant
        self.api: ApiClient
        self.member_api: ApiClient
        self._collection: Item | None = None

    async def setup(self) -> TaxonomyScene:
        self.admin = await self.world.make_user()
        self.ws = await self.world.make_workspace(self.admin)
        self.member = await self.world.add_member(self.ws)
        self.api = await self.client.as_(self.admin)
        self.member_api = await self.client.as_(self.member)
        return self

    def url(self, path: str) -> str:
        return f"/api/v1/workspaces/{self.ws.id}/{path}"

    def concept_name(self, scheme: str, notation: str) -> str:
        return f"workspaces/{self.ws.id}/conceptSchemes/{scheme}/concepts/{notation}"

    async def ok(self, response: Any) -> dict[str, Any]:
        assert response.status_code == 200, response.text
        return response.json()

    async def scheme(self, code: str = "domain", **body: Any) -> dict[str, Any]:
        payload = {
            "displayName": code.title(),
            "purpose": "CLASSIFICATION",
            "maxDepth": 3,
            "cardinality": {"min": 0, "max": 3, "primary": False},
            "assignTopConcepts": True,
            "autoThreshold": 0.8,
            "reviewThreshold": 0.5,
            **body,
        }
        return await self.ok(
            await self.api.post(self.url("conceptSchemes"), params={"conceptSchemeId": code}, json=payload)
        )

    async def concept(
        self,
        scheme: str,
        notation: str,
        label: str | None = None,
        *,
        broader: list[str] = (),  # type: ignore[assignment]
        **body: Any,
    ) -> dict[str, Any]:
        payload = {
            "prefLabels": [{"languageCode": "vi", "text": label or notation.title()}],
            "definition": f"Definition of {notation}.",
            "broader": [self.concept_name(scheme, parent) for parent in broader],
            **body,
        }
        return await self.ok(
            await self.api.post(
                self.url(f"conceptSchemes/{scheme}/concepts"), params={"conceptId": notation}, json=payload
            )
        )

    async def publish(self, scheme: str, *, validate_only: bool = False) -> Any:
        return await self.api.post(
            self.url(f"conceptSchemes/{scheme}:publish"), json={"validateOnly": validate_only}
        )

    async def published(self, scheme: str) -> dict[str, Any]:
        operation = await self.ok(await self.publish(scheme))
        assert operation["done"] is True, operation
        return operation["response"]

    # -- Database shortcuts (assignments, runs, audit) ---------------------------------

    async def concept_id(self, scheme: str, notation: str) -> UUID:
        async with self.sessions.begin() as session:
            found = await session.scalar(
                select(Concept.id)
                .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
                .where(
                    ConceptScheme.tenant_id == self.ws.id,
                    ConceptScheme.code == scheme,
                    Concept.notation == notation,
                )
            )
            assert found is not None, (scheme, notation)
            return found

    async def document(self, name: str | None = None) -> UUID:
        if self._collection is None:
            self._collection = await self.world.make_collection(self.ws)
        if name is None:
            return (await self.world.make_document(self._collection)).id
        return (await self.world.make_document(self._collection, item_name=name)).id

    async def label(
        self,
        item_id: UUID,
        scheme: str,
        notation: str,
        *,
        source: str = "llm",
        state: str = "accepted",
        evidence: dict[str, Any] | None = None,
    ) -> UUID:
        concept_id = await self.concept_id(scheme, notation)
        async with self.sessions.begin() as session:
            scheme_id = await session.scalar(select(Concept.scheme_id).where(Concept.id == concept_id))
            row = ItemConcept(
                item_id=item_id,
                concept_id=concept_id,
                scheme_id=scheme_id,
                source=source,
                state=state,
                confidence=None if source == "human" else 0.9,
                reviewed_by_user_id=self.admin.id if source == "human" else None,
                evidence=evidence or {},
            )
            session.add(row)
            await session.flush()
            return row.id

    async def labels(self, item_id: UUID) -> list[ItemConcept]:
        """Live (not rejected) labels of a Document."""
        async with self.sessions.begin() as session:
            return list(
                await session.scalars(
                    select(ItemConcept).where(ItemConcept.item_id == item_id, ItemConcept.state != "rejected")
                )
            )

    async def runs(self) -> list[tuple[IngestionRun, set[UUID]]]:
        async with self.sessions.begin() as session:
            runs = list(await session.scalars(select(IngestionRun).where(IngestionRun.tenant_id == self.ws.id)))
            return [
                (
                    run,
                    set(await session.scalars(select(IngestionRunItem.item_id).where(IngestionRunItem.run_id == run.id))),
                )
                for run in runs
            ]

    async def audit_actions(self) -> list[str]:
        async with self.sessions.begin() as session:
            return list(
                await session.scalars(
                    select(AuditLog.action)
                    .where(AuditLog.tenant_id == self.ws.id, AuditLog.category == "knowledge")
                    .order_by(AuditLog.created_at)
                )
            )
