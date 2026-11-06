/** Work module: pieces other slices import (Spaces, Home, Library, Reader, palette). */
export { WorkItemRow, type WorkItemRowProps } from "./components/WorkItemRow";
export {
  WORK_KINDS,
  enabledWorkflowIds,
  isSpaceStaff,
  isWorkKind,
  kindMeta,
  newWorkHref,
  spaceFits,
  workflowOf,
  workflowsFor,
  type KindMeta,
  type WorkKind,
  type Workflow,
  type WorkflowId,
} from "./kinds";
export { workStatus, workSummary } from "./model";
export { useWorkList } from "./queries";
