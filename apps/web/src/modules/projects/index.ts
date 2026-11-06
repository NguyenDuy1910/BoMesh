/**
 * Projects and conversation lists (preview `features/projects.js`, `conversations.js`).
 * Projects have no `/api/v1` resource: see `types.ts` for the contract and `adapter.ts`
 * for the production (unavailable) and development implementations.
 */
export { projectsAdapter, projectsAvailable } from "./adapter";
export {
  attachConversationToProject,
  conversationKeys,
  useConversationProject,
  useConversations,
  useProjectReferences,
  useProjects,
} from "./queries";
export { conversationTitle, type Conversation } from "./conversations";
export {
  ConversationMenu,
  type ConversationMenuProps,
} from "./components/ConversationMenu";
export {
  MAX_PROJECT_REFERENCES,
  type Project,
  type ProjectsAdapter,
  type ProjectScope,
} from "./types";
