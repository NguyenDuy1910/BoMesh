"use client";

import {
  MAX_PROJECT_REFERENCES,
  ProjectNotFoundError,
  type CreateProjectInput,
  type Project,
  type ProjectPatch,
  type ProjectScope,
  type ProjectsAdapter,
} from "./types";

/**
 * Development-only projects (enabled with `NEXT_PUBLIC_BOMESH_DEV_ADAPTERS=1`): kept in this
 * browser's localStorage per user and workspace, never sent to the server. The UI marks them
 * "Development data". Deleted projects are kept (with `deleteTime`) so Undo can restore them.
 */

interface StoredProject extends Project {
  deleteTime?: string;
}

const PREFIX = "bomesh.dev.projects";
const keyOf = (scope: ProjectScope) =>
  `${PREFIX}:${scope.workspace}:${scope.user}`;
const listeners = new Set<() => void>();

function read(scope: ProjectScope): StoredProject[] {
  try {
    const raw = window.localStorage.getItem(keyOf(scope));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as StoredProject[]) : [];
  } catch {
    return [];
  }
}

function write(scope: ProjectScope, projects: StoredProject[]) {
  window.localStorage.setItem(keyOf(scope), JSON.stringify(projects));
  listeners.forEach((listener) => listener());
}

const live = (p: StoredProject) => !p.deleteTime;
const strip = ({
  deleteTime: _deleteTime,
  ...project
}: StoredProject): Project => project;
const now = () => new Date().toISOString();

function mutate(
  scope: ProjectScope,
  id: string,
  change: (project: StoredProject, all: StoredProject[]) => void,
  includeDeleted = false,
): Project {
  const all = read(scope);
  const project = all.find((p) => p.id === id && (includeDeleted || live(p)));
  if (!project) throw new ProjectNotFoundError();
  change(project, all);
  project.updateTime = now();
  write(scope, all);
  return strip(project);
}

/** Removes the conversations from every live project except `keep`. */
function unfile(
  all: StoredProject[],
  conversations: readonly string[],
  keep?: string,
) {
  const moving = new Set(conversations);
  for (const p of all)
    if (live(p) && p.id !== keep && p.conversations.some((c) => moving.has(c)))
      p.conversations = p.conversations.filter((c) => !moving.has(c));
}

export const devProjectsAdapter: ProjectsAdapter = {
  status: "development",

  async list(scope) {
    return read(scope).filter(live).map(strip);
  },

  async create(scope, { displayName, conversations = [] }: CreateProjectInput) {
    const all = read(scope);
    const time = now();
    const project: StoredProject = {
      id: `pj${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      displayName,
      conversations: [...conversations],
      references: [],
      createTime: time,
      updateTime: time,
    };
    unfile(all, conversations);
    all.unshift(project);
    write(scope, all);
    return strip(project);
  },

  async update(scope, id, patch: ProjectPatch) {
    return mutate(scope, id, (project) => {
      if (patch.displayName !== undefined)
        project.displayName = patch.displayName;
      if (patch.references !== undefined)
        project.references = [...new Set(patch.references)].slice(
          0,
          MAX_PROJECT_REFERENCES,
        );
    });
  },

  async delete(scope, id) {
    return mutate(scope, id, (project) => {
      project.deleteTime = now();
    });
  },

  async undelete(scope, id) {
    return mutate(
      scope,
      id,
      (project, all) => {
        const filedElsewhere = new Set(
          all
            .filter((p) => live(p) && p.id !== id)
            .flatMap((p) => p.conversations),
        );
        project.conversations = project.conversations.filter(
          (c) => !filedElsewhere.has(c),
        );
        delete project.deleteTime;
      },
      true,
    );
  },

  async setConversationProject(scope, conversation, projectId) {
    const all = read(scope);
    const target = projectId
      ? all.find((p) => p.id === projectId && live(p))
      : null;
    if (projectId && !target) throw new ProjectNotFoundError();
    unfile(all, [conversation], projectId ?? undefined);
    if (target && !target.conversations.includes(conversation)) {
      target.conversations.unshift(conversation);
      target.updateTime = now();
    }
    write(scope, all);
  },

  subscribe(listener) {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith(PREFIX)) listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  },
};
