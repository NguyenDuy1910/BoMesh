"use client";

import clsx from "clsx";
import { List as ListIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useWorkspace } from "@/lib/workspace";
import { LinkButton } from "@/modules/curation/components/parts";
import { AddSourceButton } from "@/modules/ingestion";

import type { WorkspaceOverview } from "../api";
import { useHasTopics, useSources } from "../queries";
import type { Attn } from "./Attention";

export interface SetupStep {
  id: "collections" | "topics" | "sources" | "sync";
  done: boolean;
  title: string;
  desc: string;
  cta: ReactNode;
}

/**
 * The first-time order (preview `setupSteps()` in curation.js): one step per Studio setup section, then the first sync.
 * `steps` is undefined until every input has loaded, or when the caller isn't a workspace admin.
 */
export function useSetupSteps(overview: WorkspaceOverview | undefined): SetupStep[] | undefined {
  const { can } = useWorkspace();
  const admin = can("workspaces.updateSettings") && can("topics.update") && can("sources.create");
  const sources = useSources();
  const topics = useHasTopics({ enabled: admin });
  if (!admin || !overview || !sources.data || topics.data === undefined) return undefined;
  const collections = (overview.kpis?.find((k) => k.key === "rootCollections")?.value ?? 0) > 0;
  const synced = sources.data.some((s) => Boolean(s.lastSync?.endTime) || s.lastSync?.state === "SUCCEEDED");
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
      id: "topics",
      done: topics.data,
      title: "Nạp chủ đề",
      desc: "Các lĩnh vực và chủ đề dùng để xếp tài liệu, cùng những từ giúp nhận ra chúng. Hãy nhập trước lần đồng bộ đầu để mọi tài liệu được phân loại ngay khi đến.",
      cta: (
        <LinkButton href="/studio?tab=topics&view=topics&import=1" variant="secondary">
          Nhập chủ đề
        </LinkButton>
      ),
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
      desc: "Theo dõi quá trình đọc, phân loại và công bố. Duyệt những gì trợ lý chưa chắc, sau đó để lịch tự chạy.",
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
  return { id: "setup", tone: "accent", icon: ListIcon, title: s.title, desc: s.desc, actions: s.cta };
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
