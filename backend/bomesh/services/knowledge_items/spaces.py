"""``collection.space``: space names resolve through the Collaboration slice."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.errors import InvalidArgument
from bomesh.services.collaboration.membership import space_codes, space_id_for_code
from bomesh.services.collaboration.records import space_name
from bomesh.services.collaboration.support import parse_space_name

FIELD = "collection.space"


async def space_id_of(session: AsyncSession, workspace_id: UUID, name: str) -> UUID:
    """The live space ``name`` (``workspaces/{workspace}/spaces/{space}``) names."""

    code = parse_space_name(name, workspace_id, field=FIELD)
    space_id = await space_id_for_code(session, workspace_id, code)
    if space_id is None:
        raise InvalidArgument.for_field(FIELD, f"The space '{name}' does not exist.")
    return space_id


async def space_name_of(session: AsyncSession, workspace_id: UUID, space_id: UUID) -> str | None:
    """The resource name of space ``space_id``, deleted spaces included."""

    code = (await space_codes(session, [space_id])).get(space_id)
    return space_name(workspace_id, code) if code is not None else None


__all__ = ["space_id_of", "space_name_of"]
