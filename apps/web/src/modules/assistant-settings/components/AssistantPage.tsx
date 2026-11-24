"use client";

import { Button, Description, FieldError, Header, Input, Label, ListBox, Select, Skeleton, TextArea, TextField } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye, FileText, Paperclip, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { ChoiceGroup, Disclosure, ErrorState, IconButton, Page, PageHeader, SaveBar, SkeletonCards, StatusChip, SwitchRow, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { chatKeys, getAssistant } from "@/modules/chat/api";
import { SideDrawer } from "@/modules/people/components/SideDrawer";
import { useRolesQuery } from "@/modules/people/queries";

import { updateAssistant } from "../api";
import {
  MAX_INSTRUCTIONS,
  MAX_STARTERS,
  MAX_WELCOME,
  STYLES,
  draftErrors,
  draftKey,
  moveStarter,
  rolesOf,
  starterKey,
  startersFor,
  toDraft,
  toPatch,
  type AssistantDraft,
  type AssistantLike,
  type Starter,
} from "../model";

function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card__header">
        <div className="grow">
          <h3 className="card__title">{title}</h3>
          {description ? <p className="card__description">{description}</p> : null}
        </div>
      </div>
      {children}
    </div>
  );
}

const Counter = ({ n, max }: { n: number; max: number }) => <span className={n > max ? "counter asst-over" : "counter"}>{`${fmtNum(n)}/${fmtNum(max)}`}</span>;

/** Select key for the Everyone list (its audience is ""). */
const EVERYONE = "everyone";

/**
 * Assistant (preview `P.assistant`): a local draft with a live preview; Publish writes the workspace assistant.
 * Below 1024 px the preview sits behind the header's Preview button (a drawer).
 */
export function AssistantPage() {
  const m = useMessages();
  const { id: ws } = useWorkspace();
  const query = useQuery({ queryKey: chatKeys.assistant(ws), queryFn: () => getAssistant(ws) });
  const [previewing, setPreviewing] = useState(false);
  return (
    <Page>
      <PageHeader
        title={m.nav.assistant}
        actions={
          query.data ? (
            <Button variant="secondary" className="asst-prev-open" onPress={() => setPreviewing(true)}>
              <Eye className="i" aria-hidden />
              Xem trước
            </Button>
          ) : null
        }
      />
      {query.data ? (
        <AssistantEditor key={query.data.etag} published={query.data as AssistantLike} previewing={previewing} onPreviewClose={() => setPreviewing(false)} />
      ) : query.isError ? (
        <ErrorState error={query.error} title="Không tải được cài đặt trợ lý" onRetry={() => void query.refetch()} />
      ) : (
        <div className="asst-layout">
          <div className="stack gap-16">
            <SkeletonCards cards={2} columns="cols-auto" />
          </div>
          <div className="card">
            <Skeleton style={{ height: 280 }} />
          </div>
        </div>
      )}
    </Page>
  );
}

function AssistantEditor({ published, previewing, onPreviewClose }: { published: AssistantLike; previewing: boolean; onPreviewClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { id: ws } = useWorkspace();
  const workspaceRoles = useRolesQuery();
  const [draft, setDraft] = useState<AssistantDraft>(() => toDraft(published));
  const [tried, setTried] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [audience, setAudience] = useState("");
  const own = Boolean(audience && draft.starters[audience]);
  const list = startersFor(draft, audience);
  const listKey = own ? audience : "";
  const errs = draftErrors(draft);
  const show = (k: string) => (errs[k] && (tried || touched[k] || k === "instructions") ? errs[k] : "");
  const nErr = Object.keys(errs).length;
  const dirty = draftKey(draft) !== draftKey(toDraft(published));
  const roles = workspaceRoles.data ?? [];
  const roleName = (name: string) => roles.find((r) => r.name === name)?.label ?? "Thành viên";
  const ownCount = rolesOf(draft)?.length ?? 0;
  const touch = (k: string) => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  const setList = (next: Starter[]) => setDraft((d) => ({ ...d, starters: { ...d.starters, [listKey]: next } }));

  async function publish() {
    if (busy) return;
    if (nErr) {
      setTried(true);
      // Show the list with the problem when the one on screen is fine.
      const bad = rolesOf(draft)?.find((r) => Object.keys(errs).some((k) => k.startsWith(`${r}-st`)));
      if (bad && !Object.keys(errs).some((k) => k.startsWith(`${listKey ? `${listKey}-` : ""}st`))) setAudience(bad);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.asst-form [aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      const { body, updateMask } = toPatch(draft, published);
      const saved = await updateAssistant(ws, body, updateMask);
      qc.setQueryData(chatKeys.assistant(ws), saved);
      toast("Đã công bố trợ lý", { action: { label: "Mở trò chuyện", onPress: () => router.push("/chat") } });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
      setBusy(false);
    }
  }

  const discard = () => {
    setDraft(toDraft(published));
    setTried(false);
    setTouched({});
    setAudience("");
    toast("Đã hủy thay đổi", { tone: "accent" });
  };

  const note = !audience
    ? ownCount
      ? `Hiển thị cho người có vai trò chưa có gợi ý riêng (${plural(ownCount, "role")} đã có).`
      : "Hiển thị cho mọi người trong không gian làm việc."
    : own
      ? `Hiển thị cho người có vai trò ${roleName(audience)}.`
      : `Người có vai trò ${roleName(audience)} thấy gợi ý của Mọi thành viên.`;

  const starters =
    audience && !own ? (
      <div className="asst-aud-empty">
        <Button size="sm" variant="secondary" onPress={() => setDraft((d) => ({ ...d, starters: { ...d.starters, [audience]: (d.starters[""] ?? []).map((s) => ({ ...s })) } }))}>
          <Plus className="i" aria-hidden />
          {`Tạo gợi ý riêng cho ${roleName(audience)}`}
        </Button>
      </div>
    ) : (
      <>
        {list.length ? (
          <div className="asst-starters">
            {list.map((s, i) => {
              const tk = starterKey(listKey, i, "t");
              const pk = starterKey(listKey, i, "p");
              const edit = (patch: Partial<Starter>, key: string) => {
                setList(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                touch(key);
              };
              return (
                <div key={i} className="asst-starter" role="group" aria-label={`Gợi ý mở đầu ${i + 1}`}>
                  <div className="asst-starter__fields">
                    <TextField value={s.title} onChange={(title) => edit({ title }, tk)} isInvalid={Boolean(show(tk))} maxLength={40}>
                      <Label>Tiêu đề</Label>
                      <Input placeholder="Tìm chính sách" translate="no" />
                      <FieldError>{show(tk)}</FieldError>
                    </TextField>
                    <TextField value={s.prompt} onChange={(prompt) => edit({ prompt }, pk)} isInvalid={Boolean(show(pk))} maxLength={160}>
                      <Label>Câu lệnh</Label>
                      <Input placeholder="Quy chế công tác nói gì về công tác phí?" translate="no" />
                      <FieldError>{show(pk)}</FieldError>
                    </TextField>
                  </div>
                  <div className="asst-starter__actions">
                    <IconButton icon={ArrowUp} tip="Chuyển lên" size="sm" isDisabled={i === 0} onPress={() => (setList(moveStarter(list, i, -1)), setTouched({}))} />
                    <IconButton icon={ArrowDown} tip="Chuyển xuống" size="sm" isDisabled={i === list.length - 1} onPress={() => (setList(moveStarter(list, i, 1)), setTouched({}))} />
                    <IconButton icon={Trash2} tip="Gỡ gợi ý mở đầu" size="sm" onPress={() => (setList(list.filter((_, j) => j !== i)), setTouched({}))} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="t-sm muted">{audience ? `Chưa có gợi ý. ${roleName(audience)} chỉ thấy lời chào.` : "Chưa có gợi ý. Mọi thành viên chỉ thấy lời chào."}</p>
        )}
        <div className="row between gap-8">
          {list.length < MAX_STARTERS ? (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                setList([...list, { title: "", prompt: "" }]);
                requestAnimationFrame(() => document.querySelectorAll<HTMLInputElement>(".asst-starter input")[list.length * 2]?.focus());
              }}
            >
              <Plus className="i" aria-hidden />
              Thêm gợi ý mở đầu
            </Button>
          ) : (
            <span />
          )}
          <span className="t-xs muted num">
            {list.length}/{MAX_STARTERS}
          </span>
        </div>
      </>
    );

  return (
    <>
      <div className="asst-layout">
        <div className="asst-form">
          <Card title="Hướng dẫn">
            <TextField value={draft.instructions} onChange={(instructions) => setDraft((d) => ({ ...d, instructions }))} isInvalid={Boolean(show("instructions"))} aria-label="Hướng dẫn">
              <TextArea rows={7} />
              {show("instructions") ? (
                <FieldError>{show("instructions")}</FieldError>
              ) : (
                <div className="row between gap-12">
                  <Description>Phục vụ ai, ưu tiên gì, tránh gì.</Description>
                  <Counter n={draft.instructions.length} max={MAX_INSTRUCTIONS} />
                </div>
              )}
            </TextField>
          </Card>
          <Card title="Kiểu trả lời">
            <div className="asst-style">
              <ChoiceGroup
                label="Kiểu trả lời"
                name="asst-style"
                columns={3}
                value={draft.style}
                onChange={(style) => setDraft((d) => ({ ...d, style }))}
                options={STYLES.map((s) => ({ value: s.value, title: s.title, description: s.description }))}
              />
            </div>
          </Card>
          <Card title="Trang chủ trò chuyện" description="Những gì mọi người thấy khi bắt đầu cuộc trò chuyện mới.">
            <TextField value={draft.welcome} onChange={(v) => (setDraft((d) => ({ ...d, welcome: v })), touch("welcome"))} isRequired isInvalid={Boolean(show("welcome"))}>
              <Label>Lời chào</Label>
              <Input placeholder="Tôi có thể giúp bạn tìm gì?" translate="no" />
              {show("welcome") ? (
                <FieldError>{show("welcome")}</FieldError>
              ) : (
                <div className="row end">
                  <Counter n={draft.welcome.length} max={MAX_WELCOME} />
                </div>
              )}
            </TextField>
            <div className="asst-aud-row">
              <span className="label" id="asst-aud-label">
                Gợi ý mở đầu cho
              </span>
              <Select
                aria-labelledby="asst-aud-label"
                className="asst-aud"
                value={audience || EVERYONE}
                onChange={(key) => key != null && setAudience(key === EVERYONE ? "" : String(key))}
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id={EVERYONE} textValue="Mọi thành viên">
                      Mọi thành viên
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    {roles.length ? (
                      <ListBox.Section>
                        <Header>Vai trò</Header>
                        {roles.map((r) => {
                          const label = `${r.label}${draft.starters[r.name] ? ` · ${plural(draft.starters[r.name].length, "starter")}` : ""}`;
                          return (
                            <ListBox.Item key={r.name} id={r.name} textValue={label}>
                              {label}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          );
                        })}
                      </ListBox.Section>
                    ) : null}
                  </ListBox>
                </Select.Popover>
              </Select>
              {own ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setDraft((d) => {
                      const rest = { ...d.starters };
                      delete rest[audience];
                      return { ...d, starters: rest };
                    });
                    setTouched({});
                  }}
                >
                  Dùng gợi ý của Mọi thành viên
                </button>
              ) : null}
            </div>
            <p className="t-xs muted asst-aud-note">{note}</p>
            {starters}
          </Card>
          <Disclosure icon={SlidersHorizontal} title="Khả năng" summary={draft.fileWork ? "Đã bật tất cả" : "Đã bật 1/2"}>
            <p className="t-sm muted asst-caps__note">Câu trả lời luôn lấy từ tài liệu của tổ chức.</p>
            <div className="asst-switches">
              <SwitchRow title="Trích dẫn nguồn" description="Mỗi nhận định đều liên kết đến đoạn trích gốc." isSelected isDisabled onChange={() => undefined} />
              <SwitchRow
                title="Phân tích và tạo tệp"
                description="Đọc bảng tính, tính toán và tạo tài liệu, bảng tính."
                isSelected={draft.fileWork}
                onChange={(fileWork) => setDraft((d) => ({ ...d, fileWork }))}
              />
            </div>
          </Disclosure>
        </div>
        <aside className="asst-preview" aria-label="Xem trước">
          <div className="card asst-prev">
            <PreviewBody draft={draft} list={list} as={audience ? `Như ${roleName(audience)} thấy` : "Như mọi người thấy"} />
          </div>
        </aside>
      </div>
      <SideDrawer
        isOpen={previewing}
        onClose={onPreviewClose}
        title="Xem trước"
        description="Những gì mọi người thấy với các thay đổi chưa công bố."
        foot={
          <Button variant="primary" onPress={onPreviewClose}>
            Quay lại chỉnh sửa
          </Button>
        }
      >
        <div className="asst-prev asst-prev--sheet">
          <PreviewBody draft={draft} list={list} as={audience ? `Như ${roleName(audience)} thấy` : "Như mọi người thấy"} />
        </div>
      </SideDrawer>
      <SaveBar
        isDirty={dirty}
        isSaving={busy}
        onDiscard={discard}
        onSave={() => void publish()}
        saveLabel="Công bố"
        message={`Thay đổi chưa lưu${tried && nErr ? ` · ${plural(nErr, "field")} cần sửa` : ""}`}
      />
    </>
  );
}

/** A sample answer for the style preview: content in the interface language, so the admin judges the style on a Vietnamese answer. */
const SAMPLE = {
  q: "Công tác phí được tính thế nào?",
  short: "Công tác trong nước được 500.000 đ/ngày, nước ngoài 110 USD/ngày cho tiền ăn.",
  lead: "Công tác phí chi trả tiền ăn và chi phí phát sinh khi đi công tác.",
  list: ["Trong nước: 500.000 đ/ngày", "Nước ngoài: 110 USD/ngày", "Ngày di chuyển được tính 75%"],
  sub: "Cách thanh toán",
  steps: ["Khai báo chuyến công tác trong vòng 30 ngày.", "Chỉ đính kèm hóa đơn lưu trú.", "Quản lý duyệt, Phòng Tài chính chi trả vào kỳ kế tiếp."],
  close: "Trường hợp ngoại lệ, hãy hỏi Phòng Tài chính trước khi đi.",
  docs: ["1 Quy chế công tác phí.pdf", "2 Hướng dẫn thanh toán.docx"],
} as const;

/** The live preview (preview `previewBody`): chat home with the welcome and starters, then a sample answer in the chosen style. */
function PreviewBody({ draft, list, as }: { draft: AssistantDraft; list: readonly Starter[]; as: string }) {
  const t = SAMPLE;
  const welcome = draft.welcome.trim();
  const tiles = list.filter((s) => s.title.trim() || s.prompt.trim());
  const cite = (n: number) => <sup className="asst-cite">{n}</sup>;
  return (
    <>
      <div className="row between gap-8">
        <span className="t-label asst-prev__title">
          <Eye className="i i-sm" aria-hidden />
          Xem trước trực tiếp
        </span>
        <span className="t-xs muted truncate">{as}</span>
      </div>
      <div className="asst-prev__home">
        <div className={welcome ? "asst-prev__welcome" : "asst-prev__welcome is-empty"} translate={welcome ? "no" : undefined}>
          {welcome || "Lời chào"}
        </div>
        <div className="asst-prev__composer">
          <span className="truncate">Hỏi bất cứ điều gì…</span>
          <span className="row gap-6">
            {draft.fileWork ? <Paperclip className="i i-sm" aria-hidden /> : null}
            <span className="asst-prev__send">
              <ArrowUp className="i i-sm" aria-hidden />
            </span>
          </span>
        </div>
        {tiles.length ? (
          <div className="asst-prev__tiles">
            {tiles.map((s, i) => (
              <div key={i} className="asst-prev__tile" translate="no">
                <div className="medium truncate">{s.title.trim() || "Chưa đặt tên"}</div>
                <div className="t-xs muted truncate">{s.prompt.trim() || "—"}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <hr className="separator" />
      <div className="t-xs muted">{`Câu trả lời mẫu · ${STYLES.find((s) => s.value === draft.style)?.title}`}</div>
      <div className="asst-prev__chat" translate="no">
        <div className="asst-prev__q">{t.q}</div>
        <div className="asst-prev__a">
          {draft.style === "CONCISE" ? (
            <p>
              {t.short}
              {cite(1)}
            </p>
          ) : (
            <>
              <p>
                {t.lead}
                {cite(1)}
              </p>
              <ul>
                <li>{t.list[0]}</li>
                <li>
                  {t.list[1]}
                  {cite(1)}
                </li>
                <li>{t.list[2]}</li>
              </ul>
              {draft.style === "DETAILED" ? (
                <>
                  <p className="asst-prev__sub">{t.sub}</p>
                  <ol>
                    <li>
                      {t.steps[0]}
                      {cite(2)}
                    </li>
                    <li>{t.steps[1]}</li>
                    <li>{t.steps[2]}</li>
                  </ol>
                  <p>{t.close}</p>
                </>
              ) : null}
            </>
          )}
          <div className="asst-prev__sources">
            <StatusChip label={t.docs[0]} icon={FileText} size="sm" />
            {draft.style === "DETAILED" ? <StatusChip label={t.docs[1]} icon={FileText} size="sm" /> : null}
          </div>
        </div>
      </div>
    </>
  );
}
