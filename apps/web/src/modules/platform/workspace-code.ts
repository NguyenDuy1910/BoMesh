/**
 * The rule for a workspace's web address (its `code`), shared by the create
 * dialog and the pending implementation so both say the same thing.
 */

/** Lowercase letters, numbers and hyphens, 3–32 long, starting and ending with a letter or number. */
export const WORKSPACE_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;

/** What is wrong with a web address, in words, or null when it is well formed. */
export function workspaceCodeProblem(code: string): string | null {
  if (!code.trim()) return "Enter a web address for the workspace.";
  if (!WORKSPACE_CODE_PATTERN.test(code)) {
    return "Use 3–32 lowercase letters, numbers or hyphens. Start and end with a letter or number.";
  }
  return null;
}
