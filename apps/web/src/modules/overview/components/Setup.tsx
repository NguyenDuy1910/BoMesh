"use client";

import clsx from "clsx";
import { List as ListIcon, Tag } from "lucide-react";
import type { ReactNode } from "react";

import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { LinkButton } from "@/modules/curation/components/parts";
import { taxonomyHref } from "@/modules/curation/model";
import { AddSourceButton } from "@/modules/ingestion";
import { useTaxonomy } from "@/modules/knowledge/queries";
import { classSchemes, conceptsOf, resourceKey, schemeOfConcept } from "@/modules/knowledge/taxonomy";

import type { WorkspaceOverview } from "../api";
import { useSources } from "../queries";
import type { Attn } from "./Attention";

export interface SetupStep {
  id: "collections" | "taxonomy" | "sources" | "sync";
  done: boolean;
  title: string;
  desc: string;
  cta: ReactNode;
  /** The Needs attention row while this step is next, when what's actually missing is narrower than the step. */
  next?: Omit<Attn, "id" | "tone">;
}

/**
 * The first-time order (preview `setupSteps()` in curation.js): one step per Studio setup section, then the first sync.
 * `steps` is undefined until every input has loaded, or when the caller isn't a workspace admin.
 */
export function useSetupSteps(overview: WorkspaceOverview | undefined): SetupStep[] | undefined {
  const { can } = useWorkspace();
  const admin = can("workspaces.updateSettings") && can("conceptSchemes.update") && can("sources.create");
  const sources = useSources();
  const taxonomy = useTaxonomy();
  if (!admin || !overview || !sources.data || taxonomy.isPending) return undefined;
  const collections = (overview.kpis?.find((k) => k.key === "rootCollections")?.value ?? 0) > 0;
  const schemes = classSchemes(taxonomy.data);
  // Concepts of the classification schemes with no definition yet: the assistant classifies by what a concept means.
  const bare = schemes.flatMap((s) => conceptsOf(taxonomy.data, s.name ?? "")).filter((c) => !c.definition?.trim());
  const classified = schemes.length > 0 && schemes.every((s) => Boolean(s.publishedVersion)) && !bare.length;
  const synced = sources.data.some((s) => Boolean(s.lastSync?.endTime) || s.lastSync?.state === "SUCCEEDED");
  const firstBare = bare[0]?.name ?? "";
  return [
    {
      id: "collections",
      done: collections,
      title: "Tạo kho tài liệu",
      desc: "Tài liệu nằm ở đâu và ai được đọc. Mỗi ranh giới truy cập một kho tài liệu — một nhóm, một bộ phận, hay toàn công ty.",
      cta: (
        <LinkButton href="/studio?tab=collections&new=1" variant="secondary">
          Tạo kho tài liệu
        </LinkButton>
      ),
    },
    {
      id: "taxonomy",
      done: classified,
      title: "Công bố các trục phân loại",
      desc: "Các trục dùng để xếp tài liệu — lĩnh vực, nghiệp vụ, loại tài liệu, đối tượng — với định nghĩa cho mọi khái niệm. Hãy công bố trước lần đồng bộ đầu tiên để mọi tài liệu được phân loại khi xử lý.",
      cta: (
        <LinkButton href={taxonomyHref()} variant="secondary">
          Mở Phân loại
        </LinkButton>
      ),
      // Named by what's actually missing (preview `X.setupNext`): concepts without a definition can't be told apart.
      next: bare.length
        ? {
            icon: Tag,
            title: `${plural(bare.length, "concept")} chưa có định nghĩa`,
            desc: "Trợ lý phân biệt các khái niệm theo ý nghĩa của chúng. Hãy định nghĩa từng khái niệm, rồi công bố trục phân loại của nó.",
            actions: (
              <LinkButton href={taxonomyHref(resourceKey(schemeOfConcept(firstBare)), { node: resourceKey(firstBare) })} variant="secondary">
                Thêm định nghĩa
              </LinkButton>
            ),
          }
        : undefined,
    },
    {
      id: "sources",
      done: sources.data.length > 0,
      title: "Thêm nguồn dữ liệu",
      desc: "Chọn thư mục, kho tài liệu đích, tần suất đồng bộ và cách công bố tài liệu.",
      cta: <AddSourceButton variant="secondary" size="sm" />,
    },
    {
      id: "sync",
      done: synced,
      title: "Kiểm tra lần đồng bộ đầu tiên",
      desc: "Theo dõi quá trình đọc, phân loại, lập chỉ mục và công bố. Quyết định những gì bị giữ lại, xác nhận khái niệm, rồi để lịch tự chạy.",
      cta: (
        <LinkButton href="/studio?tab=sources" variant="secondary">
          Mở Nguồn dữ liệu
        </LinkButton>
      ),
    },
  ];
}

/** Nothing set up yet: the full checklist is the page (preview `X.setupGuide`). */
export const isFreshWorkspace = (steps: SetupStep[] | undefined) => Boolean(steps && steps.every((s) => !s.done));

/** The next unfinished step as one Needs attention row once anything is done (preview `X.setupNext`). */
export function setupNext(steps: SetupStep[] | undefined): Attn | null {
  if (!steps) return null;
  const left = steps.filter((s) => !s.done);
  if (!left.length || left.length === steps.length) return null;
  const s = left[0];
  return { id: "setup", tone: "accent", icon: ListIcon, title: s.title, desc: s.desc, actions: s.cta, ...s.next };
}

/** The setup checklist (preview `X.setupGuide`): numbered steps, the next one carries its action. */
export function SetupGuide({ steps }: { steps: SetupStep[] }) {
  const next = steps.find((s) => !s.done);
  return (
    <section className="setup card" aria-label="Thiết lập tài liệu">
      <div className="setup__head">
        <h2 className="setup__heading grow">Thiết lập tài liệu</h2>
      </div>
      <ol className="setup__steps">
        {steps.map((s, i) => (
          <li key={s.id} className={clsx("setup__step", s === next && "is-next")}>
            <span className="setup__num" aria-hidden>
              {i + 1}
            </span>
            <div className="grow">
              <div className="setup__title">{s.title}</div>
              <p className="setup__desc">{s.desc}</p>
            </div>
            {s === next ? s.cta : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
