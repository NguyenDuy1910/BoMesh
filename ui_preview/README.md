# BoMesh UI and UX concept source

`ui_preview/` is the canonical home for BoMesh product design concepts, reusable UI patterns, and user-flow references across web and app clients.

## Canonical references

| Surface | Reference | Ownership |
| --- | --- | --- |
| Web and shared visual language | [`ux-review.html`](ux-review.html) | Canonical visual contract, design tokens, components, interaction states, responsive behavior, and end-to-end product prototype. |
| App and mobile flows | [`mobile-ux-blueprint.html`](mobile-ux-blueprint.html) | Mobile information architecture, navigation, responsive states, and interaction flows. It shares the web concept and patterns without depending on a client framework. |
| Web implementation flow | [`ux-refactor-plan.md`](ux-refactor-plan.md) | Mapping from the approved prototype to the production web architecture and rollout checks. |
| Knowledge-management UX flow | [`knowledge-management-ux-plan.md`](knowledge-management-ux-plan.md) | Knowledge, source, ingestion, access, and document UX decisions and state transitions. |

## Ownership rules

- Existing product behavior and backend contracts remain authoritative for functionality, authorization, data lifecycle, and API semantics.
- `ux-review.html` is the visual and shared-component source of truth. New web and app surfaces reuse its concept, tokens, spacing, states, and interaction patterns.
- `mobile-ux-blueprint.html` adapts the same product language to mobile constraints. It does not define a competing design system or require Flutter-specific UI patterns.
- Files under `backend/docs_design/` remain authoritative for API, database, authentication, RBAC, document, and agent contracts.
- Update these references together when a UX decision changes. Do not create parallel concept documents under `docs/`, `web/`, or `app/`.
