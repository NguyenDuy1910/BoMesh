"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronDown, ChevronUp, CircleCheck, EyeOff, Layers, Lightbulb, Pencil, Plus, Sparkles, User, X } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { EmptyState, ErrorState, FileIcon, IconButton, ItemIcon, Section, Segmented, SkeletonRows } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { listItems, type Item } from "@/modules/knowledge/api";
import { ConceptTag } from "@/modules/knowledge/components/ConceptTag";
import { useItemsByName, useKnowledgeModel } from "@/modules/knowledge/queries";
import {
  assignableConcepts,
  classSchemes,
  conceptLabel,
  conceptPathText,
  conceptState,
  resourceKey,
  schemeByName,
  schemeLabel,
  schemeOfConcept,
  type Taxonomy,
} from "@/modules/knowledge/taxonomy";

import { holdDecision, useHeldDecisions } from "../../decisions";
import { aipString, suggestedFilter } from "../../docFilter";
import { newNotation, schemeNotations, type SuggestedGroup } from "../../governance";
import { taxonomyHref } from "../../model";
import { curationKeys, suggestedKey, useCounts, useInvalidateCuration, useInvalidateTaxonomy, type ClassificationSuggestions } from "../../queries";
import { acceptProposal, confirmAssignments, rejectAssignments, rejectProposal, type ConceptProposal } from "../../taxonomyApi";
import { PlainSelect } from "../parts";
import { ActionsMenu, useApplyConcept } from "../shared";
import { ConceptDraftDialog } from "./ConceptDialogs";
import { DOT, Sample, type TaxonomyAccess } from "./parts";

/** Documents a card lists when opened (preview: the pool shows 20, then “+n nữa”). */
const OPEN_PAGE = 20;

const ORIGIN = {
  CLUSTER: ["Gom từ tài liệu chưa phân loại", Layers],
  CORRECTION: ["Từ chỉnh sửa của người duyệt", Pencil],
  MEMBER: ["Do thành viên đề xuất", User],
} as const;

/** A held per-document decision on a card's concept. */
const docKey = (item: string, concept: string) => `${item}#${concept}`;

/**
 * Classification › Gợi ý (preview `suggestionsView`), filtered by scheme: (1) labels awaiting review — the classifier's
 * suggestions grouped by concept (Accept all, View: accept or reject one by one, Reject all) and each scheme's Not
 * classified pool (file a document under a concept); (2) new concept proposals (accepting adds a draft to the tree); (3)
 * labels learned from reviewers' edits. Every decision has Undo; people who can't decide see it read-only.
 */
export function Suggestions({ taxonomy: t, access, data }: { taxonomy: Taxonomy; access: TaxonomyAccess; data: ClassificationSuggestions }) {
  const [scheme, setScheme] = useState("");
  const [done, setDone] = useState<Record<string, string>>({});
  const schemes = classSchemes(t);
  const sid = scheme && schemeByName(t, scheme) ? (schemeByName(t, scheme)?.name ?? "") : "";
  const all = !sid;
  const groups = data.groups.filter((g) => all || g.scheme === sid);
  const pools = data.pools.filter((p) => all || p.scheme.name === sid);
  const props = data.proposals.filter((p) => all || p.scheme === sid);
  const concepts = props.filter((p) => p.kind === "NEW_CONCEPT");
  const labels = props.filter((p) => p.kind === "LABEL" && t.byName.has(p.targetConcept ?? ""));
  const drafts = Object.entries(done).filter(([, c]) => conceptState(t.byName.get(c)) === "DRAFT" && (all || schemeOfConcept(c) === sid));
  const note = (s: string | undefined) =>
    all ? (
      <span className="muted" translate="no">
        {schemeLabel(schemeByName(t, s))}
      </span>
    ) : null;

  return (
    <div className="tx-sug">
      {schemes.length > 1 ? (
        <div className="tx-sug__filter">
          <Segmented label="Trục phân loại" value={scheme} onChange={setScheme} options={[{ value: "", label: "Tất cả" }, ...schemes.map((s) => ({ value: resourceKey(s.name), label: schemeLabel(s) }))]} />
        </div>
      ) : null}
      <Section title="Nhãn chờ duyệt" description="Trợ lý đã gợi ý các nhãn này nhưng chưa đủ chắc chắn để gán.">
        {groups.length || pools.length ? (
          <ul className="tx-cards">
            {groups.map((g) => (
              <GroupCard key={g.concept} taxonomy={t} group={g} scope={data.scope} access={access} note={note(g.scheme)} />
            ))}
            {pools.map((p) => (
              <PoolCard key={p.scheme.name} taxonomy={t} scheme={p.scheme.name ?? ""} filter={p.filter} n={p.n} access={access} />
            ))}
          </ul>
        ) : (
          <EmptyState icon={CircleCheck} tone="success" title="Không có gì chờ duyệt" description="Các nhãn trợ lý chưa chắc chắn và tài liệu trợ lý chưa phân loại được sẽ hiện ở đây." compact />
        )}
      </Section>
      <Section title="Đề xuất khái niệm mới" description="Chấp nhận sẽ thêm một bản nháp vào cây; tài liệu được phân loại theo khái niệm đó khi bạn công bố.">
        {concepts.length || drafts.length ? (
          <ul className="tx-cards">
            {drafts.map(([p, c]) => (
              <li key={p} className="tx-card tx-card--done">
                <div className="tx-card__head">
                  <CircleCheck className="i i-sm tx-card__ok" aria-hidden />
                  <div className="tx-card__main">
                    <div className="tx-card__title">
                      <span className="medium" translate="no">
                        {conceptLabel(t, c)}
                      </span>
                      <span>giờ là bản nháp</span>
                      {note(schemeOfConcept(c))}
                    </div>
                  </div>
                  <div className="tx-card__acts">
                    <OpenDraft concept={c} />
                  </div>
                </div>
              </li>
            ))}
            {concepts.map((p) => (
              <ProposalCard key={p.name} taxonomy={t} proposal={p} access={access} note={note(p.scheme)} onAccepted={(c) => setDone((d) => ({ ...d, [p.name ?? ""]: c }))} />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={Lightbulb}
            title="Chưa có đề xuất khái niệm mới"
            description="Khi các tài liệu chưa phân loại tạo thành một nhóm, hoặc người duyệt lặp lại cùng một chỉnh sửa, khái niệm mới sẽ được đề xuất ở đây."
            compact
          />
        )}
      </Section>
      <Section title="Học từ chỉnh sửa" description="Thêm nhãn giúp trợ lý xếp đúng tài liệu tương tự lần sau. Chưa có gì thay đổi cho đến khi bạn chấp nhận.">
        {labels.length ? (
          <ul className="tx-cards">
            {labels.map((p) => (
              <LabelCard key={p.name} taxonomy={t} proposal={p} access={access} note={note(p.scheme)} />
            ))}
          </ul>
        ) : (
          <EmptyState icon={Sparkles} title="Chưa học được gì" description="Khi người duyệt chuyển tài liệu sang một khái niệm và tiêu đề của chúng có chung từ ngữ, các từ đó được gợi ý làm nhãn." compact />
        )}
      </Section>
    </div>
  );
}

function OpenDraft({ concept }: { concept: string }) {
  const router = useRouter();
  return (
    <Button variant="ghost" size="sm" onPress={() => router.push(taxonomyHref(resourceKey(schemeOfConcept(concept)), { node: resourceKey(concept) }))}>
      Mở bản nháp
      <ArrowRight className="i" aria-hidden />
    </Button>
  );
}

const decides = <span className="t-xs muted">Quản trị viên không gian làm việc quyết định</span>;

/** A card's documents: a sample of three, or a page when opened. */
function useCardDocs(filter: string, open: boolean) {
  const { id: ws } = useWorkspace();
  return useQuery({
    queryKey: [...curationKeys.suggested(ws), "docs", filter, open],
    queryFn: () => listItems(ws, { filter, orderBy: "updateTime desc", pageSize: open ? OPEN_PAGE : 3, view: "FULL" }),
    enabled: !!filter,
    staleTime: 60_000,
  });
}

function DocLink({ item }: { item: Item }) {
  return (
    <>
      <FileIcon name={item.document?.fileName ?? item.displayName} mime={item.document?.mimeType} size="sm" />
      <NextLink className="link truncate" href={`/doc/${resourceId(item.name)}`} translate="no" title={item.displayName}>
        {item.displayName || item.document?.fileName}
      </NextLink>
    </>
  );
}

/* ── (1) Labels awaiting review: one card per concept ── */

function GroupCard({ taxonomy: t, group: g, scope, access, note }: { taxonomy: Taxonomy; group: SuggestedGroup; scope: readonly string[]; access: TaxonomyAccess; note: ReactNode }) {
  const invalidate = useInvalidateCuration();
  const held = useHeldDecisions();
  const [open, setOpen] = useState(false);
  const filter = suggestedFilter(scope, g.concept, g.except);
  // Narrower concepts with their own card leave this one: its exact size is a count of its own filter.
  const exact = useCounts([g.except.length ? { of: "items", filter } : null], { enabled: g.except.length > 0 }).data[0];
  const n = g.except.length ? (exact ?? g.n) : g.n;
  const docs = useCardDocs(filter, open);
  const items = (docs.data?.items ?? []).filter((it) => !held.has(docKey(it.name ?? "", g.concept)));
  const c = t.byName.get(g.concept);
  const parent = c?.broader?.find((b) => t.byName.has(b));
  const label = conceptLabel(t, g.concept);
  const decide = (accept: boolean, item?: Item) => {
    const scopeFilter = item ? `${filter} AND name = ${aipString(item.name ?? "")}` : filter;
    const count = item ? 1 : n;
    const what = item ? `“${item.displayName}”` : plural(count, "document");
    holdDecision({
      names: [item ? docKey(item.name ?? "", g.concept) : suggestedKey(g.concept)],
      message: accept ? `Đã chấp nhận “${label}” cho ${what}` : `Đã từ chối “${label}” cho ${what}`,
      undoneMessage: `“${label}” đã trở lại Nhãn chờ duyệt`,
      send: (init) => (accept ? confirmAssignments(g.concept, scopeFilter, init) : rejectAssignments(g.concept, scopeFilter, init)).then(() => undefined),
      onSent: invalidate,
      onFailed: invalidate,
    });
  };
  const confidence = (it: Item) => it.document?.concepts?.find((a) => a.concept === g.concept && a.state === "SUGGESTED")?.confidence;
  return (
    <li className="tx-card">
      <div className="tx-card__head">
        <div className="tx-card__main">
          <div className="tx-card__title">
            <ConceptTag taxonomy={t} concept={g.concept} href={taxonomyHref(resourceKey(g.scheme), { node: resourceKey(g.concept) })} />
            {parent ? (
              <span className="muted truncate" translate="no">
                {conceptPathText(t, parent)}
              </span>
            ) : null}
            {note}
          </div>
          <div className="tx-card__meta">
            <span>{plural(n, "document")}</span>
            {docs.data?.items?.length ? (
              <>
                {DOT}
                <Sample titles={docs.data.items.map((it) => it.displayName ?? "")} n={n} />
              </>
            ) : null}
          </div>
        </div>
        <div className="tx-card__acts">
          {access.decide ? (
            <Button variant="secondary" size="sm" onPress={() => decide(true)}>
              <Check className="i" aria-hidden />
              Chấp nhận tất cả
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onPress={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? "Ẩn" : "Xem"}
            {open ? <ChevronUp className="i" aria-hidden /> : <ChevronDown className="i" aria-hidden />}
          </Button>
        </div>
      </div>
      {open ? (
        docs.isError ? (
          <ErrorState title="Không tải được tài liệu" error={docs.error} onRetry={() => void docs.refetch()} boxed={false} compact />
        ) : !docs.data ? (
          <SkeletonRows rows={3} />
        ) : (
          <>
            <ul className="tx-sug-docs">
              {items.map((it) => {
                const conf = confidence(it);
                return (
                  <li key={it.name} className="tx-sug-doc">
                    <DocLink item={it} />
                    {conf != null ? (
                      <span className="tx-sug-doc__conf" title="Mức độ chắc chắn của trợ lý">
                        {`${Math.round(conf * 100)}%`}
                      </span>
                    ) : null}
                    {access.decide ? (
                      <span className="tx-sug-doc__ops">
                        <IconButton icon={Check} tip="Chấp nhận" size="sm" onPress={() => decide(true, it)} />
                        <IconButton icon={X} tip="Từ chối" size="sm" onPress={() => decide(false, it)} />
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {n > OPEN_PAGE ? <p className="tx-sug__more muted">{`+${n - OPEN_PAGE} nữa`}</p> : null}
            {access.decide ? (
              <div className="tx-sug__more">
                <Button variant="ghost" size="sm" onPress={() => decide(false)}>
                  Từ chối tất cả
                </Button>
              </div>
            ) : null}
          </>
        )
      ) : null}
    </li>
  );
}

/** Not classified: what a scheme couldn't file with confidence. Filing one is a person's choice (and a correction). */
function PoolCard({ taxonomy: t, scheme, filter, n, access }: { taxonomy: Taxonomy; scheme: string; filter: string; n: number; access: TaxonomyAccess }) {
  const { toResource } = useKnowledgeModel();
  const apply = useApplyConcept();
  const docs = useCardDocs(filter, true);
  const options = assignableConcepts(t, scheme).map((c) => [c.name ?? "", conceptPathText(t, c.name ?? "")] as const);
  const items = docs.data?.items ?? [];
  return (
    <li className="tx-card tx-card--pool">
      <div className="tx-card__head">
        <div className="tx-card__main">
          <div className="tx-card__title">
            <span className="medium">Chưa phân loại</span>
            <span className="muted" translate="no">
              {schemeLabel(schemeByName(t, scheme))}
            </span>
          </div>
          <div className="tx-card__meta">
            <span>{plural(n, "document")}</span>
            {access.decide ? null : (
              <>
                {DOT}
                {decides}
              </>
            )}
          </div>
        </div>
      </div>
      {docs.isError ? (
        <ErrorState title="Không tải được tài liệu" error={docs.error} onRetry={() => void docs.refetch()} boxed={false} compact />
      ) : !docs.data ? (
        <SkeletonRows rows={3} />
      ) : (
        <ul className="tx-sug-docs">
          {items.map((it) => (
            <li key={it.name} className="tx-sug-doc">
              <DocLink item={it} />
              {access.decide ? (
                <span className="tx-sug-doc__ops">
                  <PlainSelect label={`Xếp ${it.displayName ?? ""} vào`} placeholder="Xếp vào…" value="" options={options} onChange={(c) => c && void apply([toResource(it)], c)} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {n > OPEN_PAGE ? <p className="tx-sug__more muted">{`+${n - OPEN_PAGE} nữa`}</p> : null}
    </li>
  );
}

/* ── (2) New concept proposals ── */

function Evidence({ names, n }: { names: readonly string[]; n: number }) {
  const { items } = useItemsByName(names.slice(0, 3), { view: "BASIC" });
  const titles = [...items.values()].map((it) => it.displayName ?? "");
  return titles.length ? (
    <>
      {DOT}
      <Sample titles={titles} n={n} />
    </>
  ) : null;
}

function ProposalCard({ taxonomy: t, proposal: p, access, note, onAccepted }: { taxonomy: Taxonomy; proposal: ConceptProposal; access: TaxonomyAccess; note: ReactNode; onAccepted: (concept: string) => void }) {
  const refresh = useInvalidateTaxonomy();
  const [accepting, setAccepting] = useState(false);
  const [origin, Icon] = ORIGIN[p.origin ?? "MEMBER"];
  const n = p.evidence?.length ?? 0;
  const scheme = schemeByName(t, p.scheme);
  const broader = p.suggestedBroader && t.byName.has(p.suggestedBroader) ? p.suggestedBroader : "";
  const name = p.displayName ?? "";
  const reject = () =>
    holdDecision({
      names: [p.name ?? ""],
      message: `Đã từ chối “${name}”`,
      undoneMessage: `“${name}” đã trở lại Đề xuất khái niệm mới`,
      send: (init) => rejectProposal(p.name ?? "", init).then(() => undefined),
      onSent: refresh,
      onFailed: refresh,
    });
  const accept = async (draft: { name: string; broader: string; definition: string }) => {
    if (!scheme?.name) return false;
    holdDecision({
      names: [p.name ?? ""],
      message: `Đã thêm “${draft.name}” làm bản nháp trong ${schemeLabel(scheme)}`,
      undoneMessage: `“${name}” đã trở lại Đề xuất khái niệm mới`,
      send: (init) =>
        acceptProposal(
          p.name ?? "",
          {
            conceptId: newNotation(draft.name, schemeNotations(t, scheme.name ?? "")),
            concept: { prefLabels: [{ languageCode: "vi", text: draft.name }], broader: draft.broader ? [draft.broader] : [], ...(draft.definition ? { definition: draft.definition } : {}) },
          },
          init,
        ).then((r) => {
          if (r.concept) onAccepted(r.concept);
        }),
      onSent: refresh,
      onFailed: refresh,
    });
    return true;
  };
  return (
    <li className="tx-card">
      <div className="tx-card__head">
        <ItemIcon icon={Icon} tone="accent" size="sm" />
        <div className="tx-card__main">
          <div className="tx-card__title">
            <span className="medium" translate="no">
              {name}
            </span>
            {broader ? (
              <>
                <span className="muted">dưới</span>{" "}
                <span className="muted" translate="no">
                  {conceptPathText(t, broader)}
                </span>
              </>
            ) : null}
            {note}
          </div>
          {p.definition ? (
            <p className="tx-card__text" translate="no">
              {p.definition}
            </p>
          ) : null}
          <div className="tx-card__meta">
            <span>{origin}</span>
            {n ? (
              <>
                {DOT}
                <span>{plural(n, "document")}</span>
              </>
            ) : null}
            <Evidence names={p.evidence ?? []} n={n} />
          </div>
        </div>
        <div className="tx-card__acts">
          {access.decide && access.create ? (
            <>
              <Button variant="secondary" size="sm" onPress={() => setAccepting(true)}>
                <Check className="i" aria-hidden />
                Chấp nhận
              </Button>
              <Button variant="ghost" size="sm" onPress={reject}>
                Từ chối
              </Button>
            </>
          ) : (
            decides
          )}
        </div>
      </div>
      {accepting && scheme ? (
        <ConceptDraftDialog
          taxonomy={t}
          scheme={scheme}
          initial={{ name, broader, definition: p.definition ?? "" }}
          title="Chấp nhận đề xuất"
          description={`Đề xuất trở thành bản nháp trong ${schemeLabel(scheme)}.`}
          submitLabel="Thêm bản nháp"
          icon={Plus}
          onSubmit={accept}
          onClose={() => setAccepting(false)}
        />
      ) : null}
    </li>
  );
}

/* ── (3) Learned from edits: labels reviewers' corrections share ── */

function LabelCard({ taxonomy: t, proposal: p, access, note }: { taxonomy: Taxonomy; proposal: ConceptProposal; access: TaxonomyAccess; note: ReactNode }) {
  const refresh = useInvalidateTaxonomy();
  const text = p.displayName ?? "";
  const target = conceptLabel(t, p.targetConcept);
  const n = p.evidence?.length ?? 0;
  const decide = (accept: boolean, labelKind: "ALT" | "HIDDEN" = "ALT") =>
    holdDecision({
      names: [p.name ?? ""],
      message: accept ? `Đã thêm “${text}” vào ${target}` : `Đã bỏ qua “${text}”`,
      undoneMessage: `“${text}” đã trở lại Học từ chỉnh sửa`,
      send: (init) => (accept ? acceptProposal(p.name ?? "", { labelKind, languageCode: "vi" }, init) : rejectProposal(p.name ?? "", init)).then(() => undefined),
      onSent: refresh,
      onFailed: refresh,
    });
  return (
    <li className="tx-card">
      <div className="tx-card__head">
        <ItemIcon icon={Sparkles} tone="accent" size="sm" />
        <div className="tx-card__main">
          <div className="tx-card__title">
            <span>{`Thêm “${text}” vào ${target}`}</span>
            {note}
          </div>
          <div className="tx-card__meta">
            <span>{`Có chung trong ${plural(n, "document")} đã sửa`}</span>
            <Evidence names={p.evidence ?? []} n={n} />
          </div>
        </div>
        <div className="tx-card__acts">
          {access.decide && access.update ? (
            <>
              <Button variant="secondary" size="sm" onPress={() => decide(true)}>
                <Plus className="i" aria-hidden />
                Chấp nhận
              </Button>
              <Button variant="ghost" size="sm" onPress={() => decide(false)}>
                Bỏ qua
              </Button>
              <ActionsMenu label="Thao tác khác cho đề xuất này" actions={[{ id: "hidden", label: "Thêm làm nhãn ẩn", icon: EyeOff, onAction: () => decide(true, "HIDDEN") }]} />
            </>
          ) : (
            decides
          )}
        </div>
      </div>
    </li>
  );
}
