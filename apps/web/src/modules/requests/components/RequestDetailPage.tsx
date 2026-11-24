"use client";

import { Button, Checkbox, Description, Dropdown, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { ArrowRight, BookOpen, Check, CheckCircle2, ClipboardList, Clock, Eye, Lock, MessageCircle, MoreHorizontal, Send, Sparkles, Undo2, Users, X, XCircle } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { confirm, EmptyState, ErrorState, ItemIcon, KeyValue, Page, PageHeader, SkeletonRows, SwitchRow, toast, UserAvatar } from "@/components/ui";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { fmtDateTime, plural, rel, relInline } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { useItem, useItemPermissions, useMember, useMemberNames } from "@/modules/knowledge/queries";
import { literal } from "@/modules/people/model";
import { SpaceMark, useSpace } from "@/modules/spaces";
import { useSpaceStaff } from "@/modules/spaces/queries";

import {
  OPEN_FILTER,
  clip,
  fieldText,
  fmtDay,
  isActive,
  isOpen,
  isQuestion,
  requestStatus,
  requestTitle,
  roleLabel,
  sentCheckLines,
  shortId,
  STAFF_ROLES,
  teamWord,
  type Request,
  type RequestMessage,
  type RequestStatus,
  type RequestType,
  type Space,
} from "../model";
import { useDecider, useRequest, useRequestAction, useRequestCount, useRequestMessages, useRequestType, type DeciderPermission, type RequestAction } from "../queries";
import { AskSpaceDialog } from "./AskSpaceDialog";
import { ButtonLink, RqCard } from "./parts";
import { RequestStatusChip, SlaText, StepChip } from "./RequestStatus";
import { RuleChecks } from "./RuleChecks";

/** /requests/:id — resolve one request (preview `P.requestItem`). */
export function RequestDetailPage({ requestId }: { requestId: string }) {
  const msg = useMessages();
  const request = useRequest(requestId);
  if (request.isError && !request.data) {
    const e = request.error;
    if (e instanceof ApiError && (e.isNotFound || e.status === 403)) {
      const denied = e.status === 403;
      return (
        <Page>
          <PageChrome crumbs={[{ label: msg.nav.requests, href: "/requests" }, { label: denied ? shortIdOf(requestId) : "Không tìm thấy" }]} />
          <EmptyState
            icon={denied ? Lock : ClipboardList}
            boxed
            title={denied ? "Bạn không thể mở yêu cầu này" : "Yêu cầu này không tồn tại"}
            description={denied ? "Chỉ người gửi và nhân viên xử lý mới xem được." : "Liên kết có thể đã cũ hoặc bị nhập sai."}
            actions={
              <ButtonLink href="/requests" variant="primary">
                Đến mục yêu cầu
              </ButtonLink>
            }
          />
        </Page>
      );
    }
    return (
      <Page>
        <PageChrome crumbs={[{ label: msg.nav.requests, href: "/requests" }, { label: shortIdOf(requestId) }]} />
        <ErrorState error={e} onRetry={() => void request.refetch()} />
      </Page>
    );
  }
  if (!request.data)
    return (
      <Page>
        <PageChrome crumbs={[{ label: msg.nav.requests, href: "/requests" }, { label: shortIdOf(requestId) }]} />
        <SkeletonRows rows={6} />
      </Page>
    );
  return <RequestView request={request.data} />;
}

const shortIdOf = (id: string) => id.slice(0, 8).toUpperCase();

type People = Map<string, { name: string; roles: string[] }>;

function RequestView({ request: r }: { request: Request }) {
  const msg = useMessages();
  const { member } = useWorkspace();
  const spaceId = resourceId(r.space);
  const type = useRequestType(r.requestType).data ?? null;
  const sp = useSpace(spaceId).data ?? null;
  const decider = useDecider(r.space);
  const messages = useRequestMessages(resourceId(r.name));
  // The space's staff (the assign picker, staff badges in the thread) and, in one batch, everyone else the page names.
  const spaceStaff = useSpaceStaff(spaceId, !!spaceId);
  const named = useMemberNames([...(messages.data ?? []).map((m) => m.author), r.assignee]);
  const requester = useMember(r.requester).data;
  const isReq = r.requester === member.name;
  const staff = decider.can("requests.get");
  const action = useRequestAction(resourceId(r.name));
  const [asking, setAsking] = useState(false);

  const people: People = new Map([...named].map(([name, displayName]) => [name, { name: displayName, roles: [] as string[] }]));
  for (const m of spaceStaff.data?.members ?? []) if (m.member) people.set(m.member, { name: m.displayName ?? "", roles: m.roles ?? [] });
  const requesterName = requester?.displayName || people.get(r.requester ?? "")?.name || "Ai đó";
  const nameOf = (who: string | undefined) => (who === r.requester ? requesterName : (people.get(who ?? "")?.name ?? (who === member.name ? (member.displayName ?? "Bạn") : "Ai đó")));
  const title = requestTitle(r, type);

  const withdraw = async () => {
    const ok = await confirm({
      title: "Rút yêu cầu này?",
      description: `${sp?.displayName || "Văn phòng"} sẽ ngừng xử lý yêu cầu. Bạn có thể gửi yêu cầu mới sau.`,
      confirmLabel: "Rút lại",
      tone: "danger",
    });
    if (!ok) return;
    action.mutate({ type: "withdraw" }, { onSuccess: () => toast("Đã rút yêu cầu"), onError: (e) => toast(errorMessage(e), { tone: "danger" }) });
  };

  // Where it was sent and when it's due sit under the title; the request ID is in the trail.
  const sub: ReactNode[] = [
    isQuestion(r) ? "Câu hỏi" : null,
    sp?.displayName ? <span translate="no">{sp.displayName}</span> : null,
    isOpen(r) && r.dueTime ? staff && !isReq ? <SlaText request={r} /> : `Dự kiến trước ${fmtDay(r.dueTime)}` : null,
  ].filter(Boolean);

  return (
    <Page className="rq-page rq-page--item">
      <PageHeader
        title={title}
        heading={<span translate={isQuestion(r) || r.title ? "no" : undefined}>{title}</span>}
        lead={sp ? <SpaceMark space={sp} size={40} /> : <ItemIcon icon={isQuestion(r) ? MessageCircle : ClipboardList} />}
        chips={<RequestStatusChip request={r} mine={isReq} space={sp} />}
        meta={
          sub.length ? (
            <span className="rq-sub">
              {sub.map((x, i) => (
                <Fragment key={i}>
                  {i ? <span aria-hidden>·</span> : null}
                  {x}
                </Fragment>
              ))}
            </span>
          ) : undefined
        }
        // Withdrawing is rare and ends the request: it lives in ⋯.
        actions={
          isReq && isActive(r) ? (
            <Dropdown>
              <Dropdown.Trigger aria-label="Thêm" className="button button--ghost button--icon-only button--muted">
                <MoreHorizontal className="i" aria-hidden />
              </Dropdown.Trigger>
              <Dropdown.Popover placement="bottom end">
                <Dropdown.Menu aria-label="Thêm" onAction={(key) => key === "withdraw" && void withdraw()}>
                  <Dropdown.Item id="withdraw" textValue="Rút yêu cầu" variant="danger">
                    <Undo2 className="i" aria-hidden />
                    <Label>Rút yêu cầu</Label>
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          ) : undefined
        }
        crumbs={[{ label: msg.nav.requests, href: staff && !isReq ? "/requests?tab=queue" : "/requests" }, { label: shortId(r) }]}
      />
      <div className="rq-detail">
        <div className="rq-main">
          <Thread request={r} type={type} space={sp} messages={messages.data ?? []} isPending={messages.isPending} isError={messages.isError} onRetry={() => void messages.refetch()} nameOf={nameOf} people={people} />
          <Composer request={r} space={sp} isReq={isReq} staff={staff} can={decider.can} requesterName={requesterName} assigneeName={r.assignee ? nameOf(r.assignee) : undefined} onAsk={() => setAsking(true)} />
        </div>
        <aside className="rq-side" aria-label="Chi tiết yêu cầu">
          <SideCards request={r} isReq={isReq} staff={staff} canAssign={decider.can("requests.update")} requesterName={requesterName} requesterEmail={requester?.email} people={people} nameOf={nameOf} />
        </aside>
      </div>
      {sp ? <AskSpaceDialog space={sp} isOpen={asking} onClose={() => setAsking(false)} /> : null}
    </Page>
  );
}

/* ═══════════════ Thread ═══════════════ */

interface Entry {
  key: string;
  at: string;
  node: ReactNode;
}

/** The step a staff message took, inferred from the request's state and times (messages carry no status). */
function stepOf(r: Request, m: RequestMessage, lastStaff: RequestMessage | undefined): RequestStatus | null {
  if (m.author === r.requester) return null;
  const st = requestStatus(r);
  if (st === "needs_info" && m === lastStaff) return "needs_info";
  if ((r.state === "APPROVED" || r.state === "DENIED" || r.state === "ANSWERED") && r.closeTime && m.createTime && Math.abs(Date.parse(m.createTime) - Date.parse(r.closeTime)) < 5000) return st;
  return null;
}

function Thread({
  request: r,
  type: t,
  space: sp,
  messages,
  isPending,
  isError,
  onRetry,
  nameOf,
  people,
}: {
  request: Request;
  type: RequestType | null;
  space: Space | null;
  messages: RequestMessage[];
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  nameOf: (who: string | undefined) => string;
  people: People;
}) {
  const { member } = useWorkspace();
  const you = (who: string | undefined) => (who === member.name ? "Bạn" : nameOf(who));
  const lastStaff = [...messages].reverse().find((m) => m.author !== r.requester);
  // What was asked sits right under "submitted": staff read it before they decide, requesters see what they sent.
  const answers = isQuestion(r) ? [] : (t?.fields ?? []).map((f) => [f.displayName || f.key, fieldText(f, (r.fields ?? {})[f.key])] as const);
  const entries: Entry[] = [];
  entries.push({
    key: "submitted",
    at: r.createTime ?? "",
    node: (
      <>
        <Event icon={Send} who={you(r.requester)} text={isQuestion(r) ? `đã hỏi ${teamWord(sp)}` : "đã gửi yêu cầu này"} at={r.createTime} />
        {answers.length ? (
          <dl className="rq-answers rq-answers--thread">
            {answers.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd translate="no">{v === "—" ? <span className="muted">—</span> : v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {r.assistantContext?.answer ? (
          <div className="rq-ai rq-ai--thread">
            <Sparkles className="i i-sm" aria-hidden />
            <div className="grow">
              <div className="rq-ai__label">Những gì trợ lý phát hiện</div>
              <p translate="no">{clip(r.assistantContext.answer, 280)}</p>
            </div>
          </div>
        ) : null}
      </>
    ),
  });
  for (const m of messages) {
    const staffMsg = m.author !== r.requester;
    const step = stepOf(r, m, lastStaff);
    const role = m.internal ? "Ghi chú nội bộ" : staffMsg ? roleLabel(people.get(m.author ?? "")?.roles) : "";
    const faq = step === "completed" && r.faqItem;
    entries.push({
      key: m.name ?? m.createTime ?? "",
      at: m.createTime ?? "",
      node: (
        <article className={staffMsg ? "rq-msg rq-msg--staff" : "rq-msg"}>
          <UserAvatar name={nameOf(m.author)} size="sm" />
          <div className="rq-msg__body">
            <header className="rq-msg__head">
              <span className="medium" translate="no">
                {you(m.author)}
              </span>
              {role ? <span className="rq-msg__role">{role}</span> : null}
              <time className="rq-time" title={fmtDateTime(m.createTime)} dateTime={m.createTime}>
                {rel(m.createTime)}
              </time>
            </header>
            {step ? (
              <div className="rq-msg__status">
                <ArrowRight className="i i-sm" aria-hidden />
                <StepChip request={r} status={step} />
              </div>
            ) : null}
            {m.text ? (
              <div className="rq-msg__text" translate="no" style={{ whiteSpace: "pre-line" }}>
                {m.text}
              </div>
            ) : null}
            {faq ? <FaqLink item={r.faqItem ?? ""} answer={m.text} course={sp?.spaceType === "course"} /> : null}
          </div>
        </article>
      ),
    });
  }
  // Closing steps without a message of their own.
  const st = requestStatus(r);
  const decidedByMessage = messages.some((m) => stepOf(r, m, lastStaff) === st);
  if (r.closeTime && !decidedByMessage && (st === "withdrawn" || st === "completed" || st === "approved" || st === "declined")) {
    const text = st === "withdrawn" ? "đã rút yêu cầu này" : st === "completed" ? (isQuestion(r) ? "Câu hỏi này đã được trả lời" : "Yêu cầu này đã được đánh dấu hoàn tất") : st === "approved" ? "Yêu cầu này đã được phê duyệt" : "Yêu cầu này đã bị từ chối";
    entries.push({
      key: "closed",
      at: r.closeTime,
      node: <Event icon={st === "withdrawn" ? Undo2 : Clock} who={st === "withdrawn" ? you(r.requester) : ""} text={text} at={r.closeTime} />,
    });
    if (st === "completed" && r.faqItem) entries.push({ key: "faq", at: r.closeTime, node: <FaqLink item={r.faqItem} course={sp?.spaceType === "course"} /> });
  }
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (
    <section className="card rq-thread" aria-label="Nhật ký hoạt động">
      {entries.map((e) => (
        <Fragment key={e.key}>{e.node}</Fragment>
      ))}
      {isPending ? <SkeletonRows rows={2} /> : null}
      {isError ? <ErrorState error={undefined} onRetry={onRetry} boxed={false} /> : null}
    </section>
  );
}

function Event({ icon: Icon, who, text, at }: { icon: typeof Send; who: string; text: string; at?: string }) {
  return (
    <div className="rq-event">
      <span className="rq-event__icon">
        <Icon className="i i-sm" aria-hidden />
      </span>
      <span className="grow">
        {who ? (
          <>
            <span className="medium fg" translate="no">
              {who}
            </span>{" "}
          </>
        ) : null}
        {text}
      </span>
      <time className="rq-time" title={fmtDateTime(at)} dateTime={at}>
        {rel(at)}
      </time>
    </div>
  );
}

const faqHref = (item: string, answer?: string) => `/doc/${resourceId(item)}${answer ? `?q=${encodeURIComponent(clip(answer, 120))}&page=1` : ""}`;

function FaqLink({ item, answer, course }: { item: string; answer?: string; course: boolean }) {
  const doc = useItem(item);
  if (doc.isError || doc.data?.state === "DELETED") return null;
  return (
    <NextLink className="rq-faq-link" href={faqHref(item, answer)} title={doc.data?.displayName}>
      <BookOpen className="i i-sm" aria-hidden />
      <span className="truncate">{course ? "Đã thêm vào Câu hỏi thường gặp của môn học" : "Đã thêm vào Câu hỏi thường gặp"}</span>
    </NextLink>
  );
}

/* ═══════════════ Composer ═══════════════ */

/**
 * Requesters: one Send. Staff: one Send for the note (it can ask the requester for information, which pauses
 * the SLA), then the decision (preview `composer`).
 */
function Composer({
  request: r,
  space: sp,
  isReq,
  staff,
  can,
  requesterName,
  assigneeName,
  onAsk,
}: {
  request: Request;
  space: Space | null;
  isReq: boolean;
  staff: boolean;
  can: (p: DeciderPermission) => boolean;
  requesterName: string;
  assigneeName?: string;
  onAsk: () => void;
}) {
  const { member } = useWorkspace();
  const router = useRouter();
  const action = useRequestAction(resourceId(r.name));
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [faq, setFaq] = useState(true);
  const [ask, setAsk] = useState(false);
  const [declining, setDeclining] = useState(false);
  const faqTarget = sp?.collections?.[0];
  const faqCollection = useItem(staff && isQuestion(r) ? faqTarget : undefined);
  const faqPerms = useItemPermissions(faqTarget, { enabled: staff && isQuestion(r) && !!faqTarget });
  const course = sp?.spaceType === "course";

  if (!isOpen(r)) return <ClosedNote request={r} space={sp} isReq={isReq} onAsk={onAsk} />;
  if (!isReq && !staff)
    return (
      <div className="rq-closed">
        <Eye className="i i-sm" aria-hidden />
        <span>{`Bạn xem được yêu cầu này, nhưng chỉ ${sp?.displayName || "nhân viên phụ trách"} mới xử lý được.`}</span>
      </div>
    );
  // APPROVED takes no messages (CreateRequestMessage → FAILED_PRECONDITION); staff can only mark it completed.
  if (r.state === "APPROVED")
    return isReq ? (
      <div className="rq-closed">
        <CheckCircle2 className="i i-sm" aria-hidden />
        <span className="grow">{`Yêu cầu này đã được phê duyệt ${relInline(r.closeTime ?? r.updateTime)}. ${sp?.displayName || "Văn phòng"} sẽ đánh dấu hoàn tất.`}</span>
      </div>
    ) : can("requests.close") ? (
      <div className="card rq-composer">
        <div className="rq-composer__actions">
          <div className="rq-composer__btns">
            <Button variant="primary" onPress={() => void action.mutateAsync({ type: "close" }).then(() => toast("Đã đánh dấu hoàn tất"), (e: unknown) => toast(errorMessage(e), { tone: "danger" }))} isPending={action.isPending}>
              <Check className="i" aria-hidden />
              Đánh dấu hoàn tất
            </Button>
          </div>
        </div>
      </div>
    ) : null;

  const canAssign = !isReq && staff && !r.assignee && can("requests.update");
  /** Staff who act on an unassigned request take it (preview `post`). */
  const run = async (a: RequestAction, success: (updated: Request | null) => void) => {
    try {
      if (canAssign && a.type !== "message") await action.mutateAsync({ type: "assign", assignee: member.name ?? "" });
      const updated = await action.mutateAsync(a);
      if (canAssign && a.type === "message") await action.mutateAsync({ type: "assign", assignee: member.name ?? "" });
      setText("");
      setErr("");
      setAsk(false);
      success(updated);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  };
  const need = (msg: string) => {
    setErr(msg);
    document.getElementById("rq-text")?.focus();
  };
  const body = text.trim();
  const busy = action.isPending;
  const needsInfo = r.state === "NEEDS_INFO";
  const asking = ask && !needsInfo;

  const reply = () => {
    if (!body) return need("Hãy viết tin nhắn trước.");
    void run({ type: "message", text: body }, () => toast(isReq ? `Đã gửi. ${assigneeName || "Văn phòng"} sẽ thấy trong hàng đợi` : `Đã gửi cho ${requesterName}`));
  };
  const askInfo = () => {
    if (!body) return need(`Hãy nói rõ bạn cần gì từ ${requesterName}.`);
    void run({ type: "sendBack", message: body }, () => toast(`Đã hỏi ${requesterName} thêm thông tin. Thời hạn SLA tạm dừng cho đến khi họ phản hồi`));
  };
  const approve = () => void run({ type: "approve", message: body || undefined }, () => toast(`Đã phê duyệt. ${requesterName} sẽ được thông báo`));
  const kbName = faqCollection.data?.displayName;
  const canFaq = staff && !isReq && isQuestion(r) && !!kbName && faqPerms.can("items.create");
  const answer = () => {
    if (!body) return need("Hãy viết câu trả lời trước.");
    const publish = faq && canFaq ? faqTarget : undefined;
    void run({ type: "answer", answer: body, publishToCollection: publish }, (updated) => {
      const doc = updated?.faqItem;
      if (doc) toast(course ? "Đã gửi câu trả lời và thêm vào Câu hỏi thường gặp của môn học" : "Đã gửi câu trả lời và thêm vào Câu hỏi thường gặp", { action: { label: "Mở Câu hỏi thường gặp", onPress: () => router.push(faqHref(doc, body)) } });
      else toast(`Đã gửi câu trả lời cho ${requesterName}`);
    });
  };

  const send = (variant: "primary" | "secondary") => (
    // Staff Send: a plain message, or — with "Ask … for information" ticked — a request for information that pauses the SLA.
    <Button variant={variant} onPress={asking ? askInfo : reply} isPending={busy}>
      <Send className="i" aria-hidden />
      Gửi
    </Button>
  );
  let label: string;
  let placeholder: string;
  let decide: ReactNode;
  if (isReq) {
    label = needsInfo ? "Phản hồi của bạn" : "Thêm tin nhắn";
    placeholder = needsInfo ? "Trả lời câu hỏi ở trên." : `Thêm thông tin cho ${sp?.displayName || "văn phòng"}.`;
    // Prominent only when the office is waiting on the requester; otherwise there's nothing to do but wait.
    decide = (
      <Button variant={needsInfo ? "primary" : "secondary"} onPress={reply} isPending={busy}>
        <Send className="i" aria-hidden />
        {needsInfo ? "Gửi phản hồi" : "Gửi"}
      </Button>
    );
  } else if (isQuestion(r)) {
    label = "Câu trả lời của bạn";
    placeholder = asking ? `Bạn cần gì từ ${requesterName}?` : `Trả lời ${requesterName}. Hãy dẫn trang chiếu hoặc tài liệu nếu có thể.`;
    decide =
      asking || !can("requests.answer") ? (
        send("primary")
      ) : (
        <Button variant="primary" onPress={answer} isPending={busy}>
          <Send className="i" aria-hidden />
          Câu trả lời
        </Button>
      );
  } else if (asking) {
    label = `Tin nhắn cho ${requesterName}`;
    placeholder = `Bạn cần gì từ ${requesterName}?`;
    decide = send("primary");
  } else {
    label = `Tin nhắn cho ${requesterName}`;
    placeholder = `Viết cho ${requesterName}, hoặc thêm ghi chú cho quyết định của bạn.`;
    decide = (
      <>
        {send("secondary")}
        {can("requests.deny") ? (
          <Button variant="danger-soft" onPress={() => setDeclining(true)} isDisabled={busy}>
            Từ chối
          </Button>
        ) : null}
        {can("requests.approve") ? (
          <Button variant="primary" onPress={approve} isPending={busy}>
            <Check className="i" aria-hidden />
            Phê duyệt
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <div className="card rq-composer">
      <TextField className="field" value={text} onChange={(v) => (setText(v), err && setErr(""))} isInvalid={!!err}>
        <Label>{label}</Label>
        <TextArea id="rq-text" rows={3} placeholder={placeholder} translate="no" />
        <FieldError>{err}</FieldError>
      </TextField>
      {canFaq && !asking ? (
        <SwitchRow
          title={course ? "Thêm câu trả lời này vào Câu hỏi thường gặp của môn học" : "Thêm câu trả lời này vào Câu hỏi thường gặp"}
          description={`Lưu vào ${kbName} để lần sau trợ lý có thể trả lời câu hỏi này.`}
          isSelected={faq}
          onChange={setFaq}
        />
      ) : null}
      {!isReq && !needsInfo && can("requests.sendBack") ? (
        <div className="rq-composer__ask">
          <Checkbox
            isSelected={ask}
            onChange={(on) => {
              setAsk(on);
              setErr("");
              requestAnimationFrame(() => document.getElementById("rq-text")?.focus());
            }}
          >
            <Checkbox.Content className="checkbox__label">
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <span>
                {`Hỏi ${requesterName} thêm thông tin`} <span className="muted">(tạm dừng SLA)</span>
              </span>
            </Checkbox.Content>
          </Checkbox>
        </div>
      ) : null}
      <div className="rq-composer__actions">
        <div className="rq-composer__btns">{decide}</div>
      </div>
      <DeclineDialog
        isOpen={declining}
        requester={requesterName}
        initial={body}
        onClose={() => setDeclining(false)}
        onDecline={(reason) =>
          void run({ type: "deny", message: reason }, () => {
            setDeclining(false);
            toast(`Đã từ chối. ${requesterName} sẽ thấy lý do của bạn`);
          })
        }
        isPending={busy}
      />
    </div>
  );
}

function DeclineDialog({ isOpen, ...props }: { isOpen: boolean; requester: string; initial: string; onClose: () => void; onDecline: (reason: string) => void; isPending: boolean }) {
  return isOpen ? <DeclineForm {...props} /> : null;
}

function DeclineForm({ requester, initial, onClose, onDecline, isPending }: { requester: string; initial: string; onClose: () => void; onDecline: (reason: string) => void; isPending: boolean }) {
  const [text, setText] = useState(initial);
  const [err, setErr] = useState("");
  const submit = () => {
    const reason = text.trim();
    if (!reason) return setErr("Thêm lý do để người yêu cầu biết cần làm gì tiếp theo.");
    onDecline(reason);
  };
  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={isPending}
      size="md"
      icon={XCircle}
      tone="danger"
      title="Từ chối yêu cầu này?"
      description={`${requester} sẽ thấy lý do của bạn và có thể gửi yêu cầu mới.`}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={isPending}>
            Hủy
          </Button>
          <Button variant="danger" onPress={submit} isPending={isPending}>
            <XCircle className="i" aria-hidden />
            Từ chối yêu cầu
          </Button>
        </>
      }
    >
      <TextField className="field" value={text} onChange={(v) => (setText(v), err && setErr(""))} isRequired isInvalid={!!err}>
        <Label>Lý do</Label>
        <TextArea rows={4} placeholder="Ví dụ: việc này cần quản lý của bạn phê duyệt trước." autoFocus translate="no" />
        {err ? <FieldError>{err}</FieldError> : <Description>Nêu lý do và họ có thể làm gì thay thế.</Description>}
      </TextField>
    </KnowledgeModal>
  );
}

function ClosedNote({ request: r, space: sp, isReq, onAsk }: { request: Request; space: Space | null; isReq: boolean; onAsk: () => void }) {
  const st = requestStatus(r);
  // Whole sentences per outcome, so each translates as one string.
  const when = relInline(r.closeTime ?? r.updateTime);
  const said =
    st === "completed"
      ? isQuestion(r)
        ? `Yêu cầu này đã được trả lời ${when}.`
        : `Yêu cầu này đã hoàn tất ${when}.`
      : st === "declined"
        ? `Yêu cầu này đã bị từ chối ${when}.`
        : st === "withdrawn"
          ? `Yêu cầu này đã được rút lại ${when}.`
          : `Yêu cầu này đã đóng ${when}.`;
  const Icon = st === "declined" ? XCircle : st === "withdrawn" ? Undo2 : CheckCircle2;
  const action = !isReq ? null : isQuestion(r) && st === "completed" ? (
    sp ? (
      <Button size="sm" variant="secondary" onPress={onAsk}>
        <MessageCircle className="i" aria-hidden />
        Hỏi tiếp
      </Button>
    ) : null
  ) : st !== "completed" && r.requestType ? (
    <ButtonLink size="sm" href={`/requests/new?space=${resourceId(r.space)}&type=${resourceId(r.requestType)}`}>
      Gửi yêu cầu mới
    </ButtonLink>
  ) : null;
  return (
    <div className="rq-closed">
      <Icon className="i i-sm" aria-hidden />
      <span className="grow">{said}</span>
      {action}
    </div>
  );
}

/* ═══════════════ Side cards ═══════════════ */

function SideCards({
  request: r,
  isReq,
  staff,
  canAssign,
  requesterName,
  requesterEmail,
  people,
  nameOf,
}: {
  request: Request;
  isReq: boolean;
  staff: boolean;
  canAssign: boolean;
  requesterName: string;
  requesterEmail?: string;
  people: People;
  nameOf: (who: string | undefined) => string;
}) {
  const { member } = useWorkspace();
  // The requester's open requests (one count); this one is among them while it is open.
  const open = useRequestCount(`requester = ${literal(r.requester ?? "")} AND ${OPEN_FILTER}`, { enabled: staff && !isReq && !!r.requester });
  const action = useRequestAction(resourceId(r.name));
  const staffPeople = [...people.entries()]
    .filter(([, p]) => p.roles.some((x) => STAFF_ROLES.includes(x)))
    .sort(([a], [b]) => Number(b === member.name) - Number(a === member.name));

  const assign = (assignee: string | null) => {
    if (assignee === (r.assignee ?? null)) return;
    const before = r.assignee ?? null;
    action.mutate(
      { type: "assign", assignee },
      {
        onSuccess: () =>
          toast(assignee === member.name ? "Được giao cho bạn" : assignee ? `Đã giao cho ${nameOf(assignee)}` : "Đã bỏ giao", {
            undo: () => action.mutate({ type: "assign", assignee: before }),
          }),
        onError: (e) => toast(errorMessage(e), { tone: "danger" }),
      },
    );
  };

  const assigneeNode = r.assignee ? (
    <span className="row gap-6" style={{ minWidth: 0 }}>
      <UserAvatar name={nameOf(r.assignee)} size="xs" />
      <span className="truncate" translate="no">
        {r.assignee === member.name ? "Bạn" : nameOf(r.assignee)}
      </span>
    </span>
  ) : (
    <span className="muted">Chưa được giao</span>
  );
  const assignCtl =
    staff && canAssign && isOpen(r) ? (
      <span className="row gap-4 none">
        {r.assignee !== member.name ? (
          <Button variant="tertiary" size="sm" onPress={() => assign(member.name ?? "")} isDisabled={action.isPending}>
            Giao cho tôi
          </Button>
        ) : null}
        <Dropdown>
          <Dropdown.Trigger aria-label="Giao cho người khác" className="button button--ghost button--sm button--icon-only button--muted">
            <Users className="i" aria-hidden />
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu aria-label="Giao cho" selectionMode="single" selectedKeys={r.assignee ? [r.assignee] : []} onAction={(key) => assign(key === "__none__" ? null : String(key))}>
              <Dropdown.Section>
                <Dropdown.Item id="__label__" isDisabled textValue="Giao cho">
                  <Label className="t-xs muted">Giao cho</Label>
                </Dropdown.Item>
                {staffPeople.map(([name, p]) => (
                  <Dropdown.Item key={name} id={name} textValue={p.name}>
                    <Label translate="no">{p.name + (name === member.name ? " (bạn)" : "")}</Label>
                    <Description>{roleLabel(p.roles)}</Description>
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
              {r.assignee ? (
                <Dropdown.Section>
                  <Dropdown.Item id="__none__" textValue="Bỏ giao">
                    <X className="i" aria-hidden />
                    <Label>Bỏ giao</Label>
                  </Dropdown.Item>
                </Dropdown.Section>
              ) : null}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </span>
    ) : null;

  const others = Math.max(0, (open.data ?? 0) - (isOpen(r) ? 1 : 0));
  const checks = sentCheckLines(r);

  return (
    <>
      <RqCard className="rq-side-card" title="Chi tiết">
        <KeyValue
          pairs={[
            ["Đã gửi", fmtDateTime(r.createTime)],
            [
              "Người phụ trách",
              <span className="rq-assignee">
                {assigneeNode}
                {assignCtl}
              </span>,
            ],
          ]}
        />
      </RqCard>
      {staff && !isReq ? (
        <RqCard className="rq-side-card" title="Người yêu cầu">
          <div className="rq-person">
            <UserAvatar name={requesterName} size="lg" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="medium truncate" translate="no">
                {requesterName}
              </div>
              <div className="t-sm muted truncate">{requesterEmail ?? ""}</div>
            </div>
          </div>
          {others ? <KeyValue pairs={[["Khác đang mở", plural(others, "request")]]} /> : null}
        </RqCard>
      ) : null}
      {checks.length ? (
        <RqCard className="rq-side-card" title="Đã kiểm tra trước khi gửi" description={`Trợ lý đã kiểm tra các quy tắc này lúc ${fmtDateTime(r.createTime)}.`}>
          <RuleChecks lines={checks} />
        </RqCard>
      ) : null}
    </>
  );
}
