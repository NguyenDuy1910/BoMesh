/**
 * Projects: personal folders for AI conversations with up to ten Knowledge references
 * attached to every new chat started in them (preview `features/projects.js`).
 *
 * `/api/v1` has no Project resource yet. This is the typed contract the web app needs;
 * `adapter.ts` picks the implementation (production: unavailable; development: browser storage).
 */

/** Most Knowledge references a project keeps (preview `MAX_REFS`). */
export const MAX_PROJECT_REFERENCES = 10;
/** Longest project name (preview `vName`). */
export const PROJECT_NAME_MAX = 60;

/** A caller-private project in one workspace. */
export interface Project {
  /** Project ID (route `/project/{id}`). */
  id: string;
  displayName: string;
  /** Conversation names (`workspaces/{w}/conversations/{c}`) filed in this project; a conversation is in at most one project. */
  conversations: string[];
  /** Document item names (`workspaces/{w}/items/{i}`), at most {@link MAX_PROJECT_REFERENCES}, attached to every new chat. */
  references: string[];
  /** RFC 3339. */
  createTime: string;
  /** RFC 3339. */
  updateTime: string;
}

/** Whose projects: projects are private to one member of one workspace. */
export interface ProjectScope {
  /** Workspace ID. */
  workspace: string;
  /** `users/{user}` of the signed-in caller. */
  user: string;
}

export interface CreateProjectInput {
  displayName: string;
  /** Conversations to file in the new project (moved out of any other project). */
  conversations?: string[];
}

/** Fields an update may change (AIP-134 style). */
export type ProjectPatch = Partial<Pick<Project, "displayName" | "references">>;

/**
 * The project operations the UI performs. A production implementation would map them to
 * `/api/v1/workspaces/{workspace}/projects` (List/Create/Update/Delete/`:undelete`) and a
 * `project` field on Conversation (see the module report for the exact proposal).
 */
export interface ProjectsAdapter {
  /** `unavailable`: the API has no projects (controls hidden). `development`: browser-stored, visibly marked. */
  readonly status: "unavailable" | "development";
  /** The caller's live projects, unordered. */
  list(scope: ProjectScope): Promise<Project[]>;
  create(scope: ProjectScope, input: CreateProjectInput): Promise<Project>;
  update(
    scope: ProjectScope,
    id: string,
    patch: ProjectPatch,
  ): Promise<Project>;
  /** Soft delete; its conversations return to Recent. Returns the deleted project. */
  delete(scope: ProjectScope, id: string): Promise<Project>;
  /** Restores a deleted project with the conversations that were not filed elsewhere since. */
  undelete(scope: ProjectScope, id: string): Promise<Project>;
  /** Files a conversation in a project (`null` = back to Recent), removing it from any other. */
  setConversationProject(
    scope: ProjectScope,
    conversation: string,
    project: string | null,
  ): Promise<void>;
  /** Called after every change (this tab or another), so caches can refresh. */
  subscribe(listener: () => void): () => void;
}

/** Thrown by the production adapter: the backend has no projects. */
export class ProjectsUnavailableError extends Error {
  constructor() {
    super("Projects aren’t available yet.");
    this.name = "ProjectsUnavailableError";
  }
}

/** Thrown when a project id does not resolve to one of the caller's live projects. */
export class ProjectNotFoundError extends Error {
  constructor() {
    super("This project isn’t available.");
    this.name = "ProjectNotFoundError";
  }
}
