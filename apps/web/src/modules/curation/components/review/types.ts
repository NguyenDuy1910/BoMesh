import type { Flag } from "../../model";
import type { Submission } from "../../queries";

/** What the queue and the detail show about one submission. */
export interface SubView {
  sub: Submission;
  /** Contribution resource name. */
  name: string;
  /** Contribution ID (`?sel=`). */
  id: string;
  title: string;
  /** The candidate document's current displayName: what approval renames (never its fileName). */
  displayName: string;
  fileName: string;
  mime: string;
  /** Contributor (member display name) or the source that synced it. */
  contributor: string;
  /** Synced from a source rather than contributed by a member. */
  via: boolean;
  /** Target (or suggested) collection, full name and display name. */
  base: string;
  baseName: string;
  resubmitted: boolean;
  analyzing: boolean;
  flags: Flag[];
}

/** The reviewer's working copy of the assistant's classification and suggestions; reset when the contribution changes
 *  (etag) or its candidate is classified again. */
export interface Draft {
  etag: string;
  /** The candidate's classification when the draft was made (`document.concepts`, its concept names): what “changed” compares to. */
  classified: string[];
  /** The concepts kept, across classification schemes (full names). */
  concepts: string[];
  /** Target collection (full name). */
  kb: string;
  summary: string;
  /** The published document's name (NEW_DOCUMENT only): the assistant's `suggestions.title`, else the current displayName. */
  title: string;
}
