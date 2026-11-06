/** Spaces module: shared pieces other slices import (Home, Shell, Chat, Requests, Work). */
export { SpaceMark, spaceColor, type SpaceMarkProps } from "./components/SpaceMark";
export { UpNextList, upNextWhen, type UpNextListProps } from "./components/UpNextList";
export { spacesKeys, invalidateSpaces, useMySpaces, useSpaces, useSpace, useUpNext, type UpNextItem, type UpNextKind } from "./queries";
export { spaceType, spaceTypesOf, roleLabel, isStaffRole, type Space, type SpaceTypeDef } from "./types";
