import type { Flag } from "../model";
import type { Submission } from "../queries";

/** What the queue and the detail show about one submission. */
export interface SubView {
  sub: Submission;
  /** Contribution resource name. */
  name: string;
  /** Contribution ID (`?sel=`). */
  id: string;
  title: string;
  fileName: string;
  mime: string;
  /** Contributor (member display name) or the source that synced it. */
  contributor: string;
  /** Synced from a source rather than contributed by a member. */
  via: boolean;
  /** Target (or suggested) knowledge base, full name and display name. */
  base: string;
  baseName: string;
  resubmitted: boolean;
  analyzing: boolean;
  flags: Flag[];
}

/** The reviewer's working copy of the assistant's suggestion; reset when the contribution changes (etag). */
export interface Draft {
  etag: string;
  kind: string;
  topics: string[];
  /** Target knowledge base (full name). */
  kb: string;
  summary: string;
  /** What the assistant suggested (Edited badges). */
  initial: { kind: string };
}
