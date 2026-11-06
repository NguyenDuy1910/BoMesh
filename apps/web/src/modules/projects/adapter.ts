"use client";

import { devProjectsAdapter } from "./dev-adapter";
import { ProjectsUnavailableError, type ProjectsAdapter } from "./types";

const unavailable = async (): Promise<never> => {
  throw new ProjectsUnavailableError();
};

/**
 * Production: `/api/v1` has no projects, so there are none and every write is refused.
 * The UI shows project controls disabled with `PROJECTS_UNAVAILABLE`, and `/project/{id}` explains it.
 */
export const unavailableProjectsAdapter: ProjectsAdapter = {
  status: "unavailable",
  list: async () => [],
  create: unavailable,
  update: unavailable,
  delete: unavailable,
  undelete: unavailable,
  setConversationProject: unavailable,
  subscribe: () => () => undefined,
};

/** The projects implementation in use: development storage only when explicitly enabled. */
export const projectsAdapter: ProjectsAdapter =
  process.env.NEXT_PUBLIC_BOMESH_DEV_ADAPTERS === "1"
    ? devProjectsAdapter
    : unavailableProjectsAdapter;

/** True when project controls should show (development adapter on). */
export const projectsAvailable = projectsAdapter.status !== "unavailable";

/** Tooltip of the "Development data" marker shown wherever development projects appear. */
export const DEV_DATA_TOOLTIP =
  "Projects are kept in this browser for development. The API has no projects yet.";

/** Reason shown on disabled project controls while the API has no projects. */
export const PROJECTS_UNAVAILABLE = "Projects aren't available yet.";
