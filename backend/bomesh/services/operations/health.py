"""Platform components and incidents, derived on read from ``platform_health_checks``.

- A **component** is one entry of :func:`bomesh.health.platform_components`
  with the state of its latest probe; a component whose setting is absent is
  ``NOT_CONFIGURED`` whatever its probes said.
- An **incident** is a run of consecutive ``degraded``/``unhealthy`` probes of
  one component. Its ID is the ID of the run's first probe; it is
  ``RESOLVED`` at the first later probe of another status.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import (
    Boolean,
    String,
    and_,
    case,
    column,
    false,
    func,
    literal,
    select,
    values,
)
from sqlalchemy.sql import Subquery

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import PlatformHealthCheck
from bomesh.errors import NotFound
from bomesh.health import ComponentSpec, platform_components
from bomesh.iam.authorizer import PlatformRef
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

#: Probe statuses that open or continue an incident.
INCIDENT_STATUSES = ("degraded", "unhealthy")
_STATES = {
    "healthy": "HEALTHY",
    "degraded": "DEGRADED",
    "unhealthy": "DOWN",
    "not_configured": "NOT_CONFIGURED",
}


@dataclass(frozen=True, slots=True)
class ComponentRecord:
    id: str
    display_name: str
    kind: str
    state: str | None
    setting: str | None
    model: str | None
    check_time: datetime | None


@dataclass(frozen=True, slots=True)
class IncidentRecord:
    id: UUID
    component: str
    state: str
    error_category: str | None
    start_time: datetime
    end_time: datetime | None


class PlatformHealthService:
    """Get and List of ``components`` and ``incidents`` (platform permissions)."""

    def __init__(self, sessions: SessionFactory, components: tuple[ComponentSpec, ...]) -> None:
        self._sessions = sessions
        self._components = components

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> PlatformHealthService:
        return cls(runtime.sessions(), platform_components(runtime.config))

    def components_table(self) -> Subquery:
        """Columns ``id, display_name, kind, state, setting, model, check_time`` to filter on."""
        return self._components_query().subquery("components")

    def incidents_table(self) -> Subquery:
        """Columns ``id, component, state, error_category, start_time, end_time`` to filter on."""
        return _incidents_query(self._components).subquery("incidents")

    async def list_components(
        self, ctx: RequestContext, query: ListQuery, table: Subquery
    ) -> list[ComponentRecord]:
        await ctx.authorizer.require(ctx.principal, "components.list", PlatformRef())
        async with transaction_scope(self._sessions) as session:
            rows = (await session.execute(query.apply(select(table)))).all()
        return [_component(row._mapping) for row in rows]

    async def get_component(self, ctx: RequestContext, component_id: str) -> ComponentRecord:
        await ctx.authorizer.require(ctx.principal, "components.get", PlatformRef())
        table = self.components_table()
        async with transaction_scope(self._sessions) as session:
            row = (await session.execute(select(table).where(table.c.id == component_id))).first()
        if row is None:
            raise NotFound(f"Component 'components/{component_id}' does not exist.")
        return _component(row._mapping)

    async def list_incidents(
        self, ctx: RequestContext, query: ListQuery, table: Subquery
    ) -> list[IncidentRecord]:
        await ctx.authorizer.require(ctx.principal, "incidents.list", PlatformRef())
        async with transaction_scope(self._sessions) as session:
            rows = (
                await session.execute(
                    query.apply(select(table).where(self._known_component(table)))
                )
            ).all()
        return [_incident(row._mapping) for row in rows]

    async def get_incident(self, ctx: RequestContext, incident_id: UUID) -> IncidentRecord:
        await ctx.authorizer.require(ctx.principal, "incidents.get", PlatformRef())
        table = self.incidents_table()
        async with transaction_scope(self._sessions) as session:
            row = (
                await session.execute(
                    select(table).where(table.c.id == incident_id, self._known_component(table))
                )
            ).first()
        if row is None:
            raise NotFound(f"Incident 'incidents/{incident_id}' does not exist.")
        return _incident(row._mapping)

    def _known_component(self, table: Subquery) -> Any:
        return table.c.service.in_([spec.probe for spec in self._components])

    def _components_query(self) -> Any:
        catalog = values(
            column("id", String),
            column("display_name", String),
            column("kind", String),
            column("probe", String),
            column("configured", Boolean),
            column("setting", String),
            column("model", String),
            name="catalog",
        ).data(
            [
                (s.id, s.display_name, s.kind, s.probe, s.configured, s.setting, s.model)
                for s in self._components
            ]
        )
        latest = (
            select(PlatformHealthCheck.status, PlatformHealthCheck.checked_at)
            .where(PlatformHealthCheck.service == catalog.c.probe)
            .order_by(PlatformHealthCheck.checked_at.desc(), PlatformHealthCheck.id.desc())
            .limit(1)
            .lateral("latest")
        )
        state = case(
            (catalog.c.configured.is_(False), literal("NOT_CONFIGURED")),
            *((latest.c.status == status, literal(name)) for status, name in _STATES.items()),
            else_=None,
        )
        return select(
            catalog.c.id,
            catalog.c.display_name,
            catalog.c.kind,
            state.label("state"),
            catalog.c.setting,
            catalog.c.model,
            latest.c.checked_at.label("check_time"),
        ).select_from(catalog.outerjoin(latest, literal(True)))


def _incidents_query(components: tuple[ComponentSpec, ...]) -> Any:
    check = PlatformHealthCheck
    bad = check.status.in_(INCIDENT_STATUSES)
    flagged = select(
        check.id,
        check.service,
        check.checked_at,
        check.error_category,
        bad.label("bad"),
        func.lag(bad)
        .over(partition_by=check.service, order_by=(check.checked_at, check.id))
        .label("previous_bad"),
    ).subquery("flagged")
    later = PlatformHealthCheck.__table__.alias("later")
    end_time = (
        select(func.min(later.c.checked_at))
        .where(
            later.c.service == flagged.c.service,
            later.c.checked_at > flagged.c.checked_at,
            later.c.status.not_in(INCIDENT_STATUSES),
        )
        .scalar_subquery()
    )
    return select(
        flagged.c.id,
        flagged.c.service,
        _component_name(flagged.c.service, components).label("component"),
        case((end_time.is_(None), literal("ONGOING")), else_=literal("RESOLVED")).label("state"),
        flagged.c.error_category,
        flagged.c.checked_at.label("start_time"),
        end_time.label("end_time"),
    ).where(and_(flagged.c.bad, func.coalesce(flagged.c.previous_bad, false()).is_(False)))


def _component_name(service: Any, components: tuple[ComponentSpec, ...]) -> Any:
    """``components/{id}`` of a probe name."""
    mapping = {spec.probe: spec.id for spec in components}
    return literal("components/") + case(mapping, value=service, else_=service)


def _component(row: Any) -> ComponentRecord:
    return ComponentRecord(
        id=row["id"],
        display_name=row["display_name"],
        kind=row["kind"],
        state=row["state"],
        setting=row["setting"],
        model=row["model"],
        check_time=row["check_time"],
    )


def _incident(row: Any) -> IncidentRecord:
    return IncidentRecord(
        id=row["id"],
        component=row["component"],
        state=row["state"],
        error_category=row["error_category"],
        start_time=row["start_time"],
        end_time=row["end_time"],
    )


__all__ = ["ComponentRecord", "IncidentRecord", "PlatformHealthService"]
