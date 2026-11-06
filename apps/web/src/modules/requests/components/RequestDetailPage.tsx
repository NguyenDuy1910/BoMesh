"use client";

import { Button, Description, Dropdown, FieldError, Label, Separator, TextArea, TextField } from "@heroui/react";
import { ArrowRight, BookOpen, Check, CheckCircle2, ClipboardList, Clock, Eye, Lock, MessageCircle, Send, Sparkles, Undo2, Users, X, XCircle } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout, confirm, EmptyState, ErrorState, KeyValue, Page, PageHeader, SkeletonRows, SwitchRow, toast, UserAvatar } from "@/components/ui";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { fmtDateTime, plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { useItem, useItemPermissions, useMember } from "@/modules/knowledge/queries";
import { SpaceMark, useSpace } from "@/modules/spaces";
import { useSpaceMembers } from "@/modules/spaces/queries";

import {
  clip,
  fieldText,
  firstName,
  fmtDay,
  isActive,
  isOpen,
  isQuestion,
  relIn,
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
import { useDecider, useRequest, useRequestAction, useRequestMessages, useRequests, useRequestType, type RequestAction } from "../queries";
import { AskSpaceDialog } from "./AskSpaceDialog";
import { LinkButton, RqCard } from "./parts";
import { RequestStatusChip, SlaText, StepChip } from "./RequestStatus";
import { RuleChecks } from "./RuleChecks";

/** /requests/:id — resolve one request (preview `P.requestItem`). */
export function RequestDetailPage({ requestId }: { requestId: string }) {
  const request = useRequest(requestId);
  if (request.isError && !request.data) {
    const e = request.error;
    if (e instanceof ApiError && (e.isNotFound || e.status === 403)) {
      const denied = e.status === 403;
      return (
        <Page>
          <PageChrome crumbs={[{ label: "Requests", href: "/requests" }, { label: denied ? shortIdOf(requestId) : "Not found" }]} />
          <EmptyState
            icon={denied ? Lock : ClipboardList}
            boxed
            title={denied ? "You can’t open this request" : "This request doesn’t exist"}
            description={denied ? "Only the person who sent it and the staff handling it can see it." : "The link may be old or mistyped."}
            actions={
              <LinkButton href="/requests" variant="primary">
                Go to requests
              </LinkButton>
            }
          />
        </Page>
      );
    }
    return (
      <Page>
        <PageChrome crumbs={[{ label: "Requests", href: "/requests" }, { label: shortIdOf(requestId) }]} />
        <ErrorState error={e} onRetry={() => void request.refetch()} />
      </Page>
    );
  }
  if (!request.data)
    return (
      <Page>
        <PageChrome crumbs={[{ label: "Requests", href: "/requests" }, { label: shortIdOf(requestId) }]} />
        <SkeletonRows rows={6} />
      </Page>
    );
  return <RequestView request={request.data} />;
}

const shortIdOf = (id: string) => id.slice(0, 8).toUpperCase();

function RequestView({ request: r }: { request: Request }) {
  const { member } = useWorkspace();
  const spaceId = resourceId(r.space);
  const type = useRequestType(r.requestType).data ?? null;
  const sp = useSpace(spaceId).data ?? null;
  const decider = useDecider(r.space);
  const messages = useRequestMessages(resourceId(r.name));
  const spaceMembers = useSpaceMembers(spaceId, !!spaceId);
  const requester = useMember(r.requester).data;
  const isReq = r.requester === member.name;
  const staff = decider.can("requests.get");
  const action = useRequestAction(resourceId(r.name));
  const [asking, setAsking] = useState(false);

  const people = new Map<string, { name: string; roles: string[] }>();
  for (const m of spaceMembers.data ?? []) if (m.member) people.set(m.member, { name: m.displayName ?? "", roles: m.roles ?? [] });
  const requesterName = requester?.displayName || people.get(r.requester ?? "")?.name || "Someone";
  const nameOf = (who: string | undefined) => (who === r.requester ? requesterName : (people.get(who ?? "")?.name ?? (who === member.name ? (member.displayName ?? "You") : "Someone")));

  const withdraw = async () => {
    const ok = await confirm({
      title: "Withdraw this request?",
      description: `${sp?.displayName || "The office"} stops working on it. You can send a new request later.`,
      confirmLabel: "Withdraw",
      tone: "danger",
    });
    if (!ok) return;
    action.mutate({ type: "withdraw" }, { onSuccess: () => toast("Request withdrawn"), onError: (e) => toast(errorMessage(e), { tone: "danger" }) });
  };

  const sub: ReactNode[] = [
    isQuestion(r) ? "Question" : null,
    sp?.displayName ? <span translate="no">{sp.displayName}</span> : null,
    isOpen(r) && r.dueTime ? staff && !isReq ? <SlaText request={r} /> : `Expected by ${fmtDay(r.dueTime)}` : null,
  ].filter(Boolean);

  return (
    <Page className="rq-page rq-page--item">
      <PageChrome crumbs={[{ label: "Requests", href: staff && !isReq ? "/requests?tab=queue" : "/requests" }, { label: shortId(r) }]} />
      <PageHeader
        lead={sp ? <SpaceMark space={sp} size={40} /> : null}
        title={<span translate={isQuestion(r) || r.title ? "no" : undefined}>{requestTitle(r, type)}</span>}
        chips={<RequestStatusChip request={r} mine={isReq} space={sp} />}
        description={
          sub.length ? (
            <span className="rq-sub">
              {sub.map((x, i) => (
                <span key={i} className="rq-sub">
                  {i ? <span aria-hidden>·</span> : null}
                  {x}
                </span>
              ))}
            </span>
          ) : undefined
        }
        actions={
          isReq && isActive(r) ? (
            <Button variant="ghost" onPress={withdraw} isPending={action.isPending && action.variables?.type === "withdraw"}>
              <Undo2 className="i" aria-hidden />
              Withdraw
            </Button>
          ) : undefined
        }
      />
      <div className="rq-detail">
        <div className="rq-main">
          <Thread request={r} space={sp} messages={messages.data ?? []} isPending={messages.isPending} isError={messages.isError} onRetry={() => void messages.refetch()} nameOf={nameOf} people={people} />
          <Composer request={r} space={sp} isReq={isReq} staff={staff} can={decider.can} requesterName={requesterName} assigneeName={r.assignee ? nameOf(r.assignee) : undefined} messages={messages.data ?? []} onAsk={() => setAsking(true)} />
        </div>
        <aside className="rq-side" aria-label="Request details">
          <SideCards request={r} type={type} space={sp} isReq={isReq} staff={staff} canAssign={decider.can("requests.update")} requesterName={requesterName} requesterEmail={requester?.email} people={people} nameOf={nameOf} />
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
  space: sp,
  messages,
  isPending,
  isError,
  onRetry,
  nameOf,
  people,
}: {
  request: Request;
  space: Space | null;
  messages: RequestMessage[];
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  nameOf: (who: string | undefined) => string;
  people: Map<string, { name: string; roles: string[] }>;
}) {
  const { member } = useWorkspace();
  const you = (who: string | undefined) => (who === member.name ? "You" : nameOf(who));
  const lastStaff = [...messages].reverse().find((m) => m.author !== r.requester);
  const entries: Entry[] = [];
  entries.push({
    key: "submitted",
    at: r.createTime ?? "",
    node: (
      <>
        <Event icon={Send} who={you(r.requester)} text={isQuestion(r) ? `asked ${teamWord(sp)}` : "submitted this request"} at={r.createTime} />
        {r.assistantContext?.answer ? (
          <div className="rq-ai rq-ai--thread">
            <Sparkles className="i i-sm" aria-hidden />
            <div className="grow">
              <div className="rq-ai__label">What the assistant found</div>
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
    const role = m.internal ? "Internal note" : staffMsg ? roleLabel(people.get(m.author ?? "")?.roles) : "";
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
              <time className="rq-time" title={fmtDateTime(m.createTime)}>
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
    const text = st === "withdrawn" ? "withdrew this request" : st === "completed" ? (isQuestion(r) ? "This question was answered" : "This request was marked completed") : st === "approved" ? "This request was approved" : "This request was declined";
    entries.push({
      key: "closed",
      at: r.closeTime,
      node: <Event icon={st === "withdrawn" ? Undo2 : Clock} who={st === "withdrawn" ? you(r.requester) : ""} text={text} at={r.closeTime} />,
    });
    if (st === "completed" && r.faqItem) entries.push({ key: "faq", at: r.closeTime, node: <FaqLink item={r.faqItem} course={sp?.spaceType === "course"} /> });
  }
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (
    <section className="card rq-thread" aria-label="Activity">
      {entries.map((e) => (
        <Fragment key={e.key}>{e.node}</Fragment>
      ))}
      {isPending ? <SkeletonRows rows={2} /> : null}
      {isError ? <ErrorState error={undefined} onRetry={onRetry} boxed={false} /> : null}
    </section>
  );
}

function Event({ icon: Icon, who, text, at, step }: { icon: typeof Send; who: string; text: string; at?: string; step?: ReactNode }) {
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
        {step ? <> {step}</> : null}
      </span>
      <time className="rq-time" title={fmtDateTime(at)}>
        {rel(at)}
      </time>
    </div>
  );
}

function FaqLink({ item, answer, course }: { item: string; answer?: string; course: boolean }) {
  const doc = useItem(item);
  if (doc.isError || doc.data?.state === "DELETED") return null;
  return (
    <NextLink className="rq-faq-link" href={`/doc/${resourceId(item)}${answer ? `?q=${encodeURIComponent(clip(answer, 120))}&page=1` : ""}`} title={doc.data?.displayName}>
      <BookOpen className="i i-sm" aria-hidden />
      <span className="truncate">{course ? "Added to the course FAQ" : "Added to the FAQ"}</span>
    </NextLink>
  );
}

/* ═══════════════ Composer ═══════════════ */

function Composer({
  request: r,
  space: sp,
  isReq,
  staff,
  can,
  requesterName,
  assigneeName,
  messages,
  onAsk,
}: {
  request: Request;
  space: Space | null;
  isReq: boolean;
  staff: boolean;
  can: (p: "requests.get" | "requests.update" | "requests.approve" | "requests.deny" | "requests.sendBack" | "requests.answer" | "requests.close") => boolean;
  requesterName: string;
  assigneeName?: string;
  messages: RequestMessage[];
  onAsk: () => void;
}) {
  const { member } = useWorkspace();
  const router = useRouter();
  const action = useRequestAction(resourceId(r.name));
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [faq, setFaq] = useState(true);
  const [declining, setDeclining] = useState(false);
  const first = firstName(requesterName);
  const faqTarget = sp?.collections?.[0];
  const faqBase = useItem(staff && isQuestion(r) ? faqTarget : undefined);
  const faqPerms = useItemPermissions(faqTarget, { enabled: staff && isQuestion(r) && !!faqTarget });
  const course = sp?.spaceType === "course";

  if (!isOpen(r)) return <ClosedNote request={r} space={sp} isReq={isReq} onAsk={onAsk} />;
  if (!isReq && !staff)
    return (
      <div className="rq-closed">
        <Eye className="i i-sm" aria-hidden />
        <span>You can see this request, but only {sp?.displayName || "its staff"} can act on it.</span>
      </div>
    );
  // APPROVED takes no messages (CreateRequestMessage → FAILED_PRECONDITION); staff can only mark it completed.
  if (r.state === "APPROVED")
    return isReq ? (
      <div className="rq-closed">
        <CheckCircle2 className="i i-sm" aria-hidden />
        <span className="grow">
          This request was approved {relIn(r.closeTime ?? r.updateTime)}. {sp?.displayName || "The office"} will mark it completed.
        </span>
      </div>
    ) : can("requests.close") ? (
      <div className="card rq-composer">
        <div className="rq-composer__actions">
          <div className="rq-composer__btns">
            <Button variant="primary" onPress={() => void action.mutateAsync({ type: "close" }).then(() => toast("Marked completed"), (e: unknown) => toast(errorMessage(e), { tone: "danger" }))} isPending={action.isPending}>
              <Check className="i" aria-hidden />
              Mark completed
            </Button>
          </div>
        </div>
      </div>
    ) : null;

  /** Staff who act on an unassigned request take it (preview `post`). */
  const run = async (a: RequestAction, success: () => void) => {
    try {
      if (!isReq && staff && !r.assignee && can("requests.update") && a.type !== "message") await action.mutateAsync({ type: "assign", assignee: member.name ?? "" });
      await action.mutateAsync(a);
      if (!isReq && staff && !r.assignee && can("requests.update") && a.type === "message") await action.mutateAsync({ type: "assign", assignee: member.name ?? "" });
      setText("");
      setErr("");
      success();
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

  const reply = () => {
    if (!body) return need("Write a message first.");
    void run({ type: "message", text: body }, () =>
      toast(isReq ? `Sent. ${assigneeName ? firstName(assigneeName) : "The office"} will see it in their queue` : `Sent to ${first}`),
    );
  };
  const askInfo = () => {
    if (!body) return need(`Say what you need from ${first}.`);
    void run({ type: "sendBack", message: body }, () => toast(`Asked ${first} for information. The SLA clock pauses until they reply`));
  };
  const approve = () => void run({ type: "approve", message: body || undefined }, () => toast(`Approved. ${first} will be notified`));
  const answer = () => {
    if (!body) return need("Write the answer first.");
    const publish = faq && faqTarget && faqPerms.can("items.create") ? faqTarget : undefined;
    void (async () => {
      try {
        if (staff && !r.assignee && can("requests.update")) await action.mutateAsync({ type: "assign", assignee: member.name ?? "" });
        const updated = await action.mutateAsync({ type: "answer", answer: body, publishToCollection: publish });
        setText("");
        setErr("");
        const doc = updated?.faqItem;
        if (doc) toast(`Answer sent and added to the ${course ? "course " : ""}FAQ`, { action: { label: "Open FAQ", onPress: () => router.push(`/doc/${resourceId(doc)}`) } });
        else toast(`Answer sent to ${first}`);
      } catch (e) {
        toast(errorMessage(e), { tone: "danger" });
      }
    })();
  };

  let label: string;
  let placeholder: string;
  let actions: ReactNode;
  if (isReq) {
    label = r.state === "NEEDS_INFO" ? "Your reply" : "Add a message";
    placeholder = r.state === "NEEDS_INFO" ? "Answer the question above." : `Add details for ${sp?.displayName || "the office"}.`;
    actions = (
      <Button variant="primary" onPress={reply} isPending={busy}>
        <Send className="i" aria-hidden />
        {r.state === "NEEDS_INFO" ? "Send reply" : "Send"}
      </Button>
    );
  } else if (isQuestion(r)) {
    label = "Your answer";
    placeholder = `Answer ${first}. Cite the slide or document if you can.`;
    actions = (
      <>
        {r.state !== "NEEDS_INFO" && can("requests.sendBack") ? (
          <Button variant="tertiary" onPress={askInfo} isDisabled={busy}>
            Ask for information
          </Button>
        ) : null}
        {can("requests.answer") ? (
          <Button variant="primary" onPress={answer} isPending={busy}>
            <Send className="i" aria-hidden />
            Answer
          </Button>
        ) : null}
      </>
    );
  } else {
    label = `Message to ${first}`;
    placeholder = `Reply, ask ${first} for something, or add a note to your decision.`;
    actions = (
      <>
        {r.state !== "NEEDS_INFO" && can("requests.sendBack") ? (
          <Button variant="tertiary" onPress={askInfo} isDisabled={busy}>
            Ask for information
          </Button>
        ) : null}
        <Button variant="tertiary" onPress={reply} isDisabled={busy}>
          Reply
        </Button>
        {can("requests.deny") ? (
          <Button variant="danger-soft" onPress={() => setDeclining(true)} isDisabled={busy}>
            Decline
          </Button>
        ) : null}
        {can("requests.approve") ? (
          <Button variant="primary" onPress={approve} isPending={busy}>
            <Check className="i" aria-hidden />
            Approve
          </Button>
        ) : null}
      </>
    );
  }

  const ask = isReq && r.state === "NEEDS_INFO" ? [...messages].reverse().find((m) => m.author !== r.requester) : undefined;
  const kbName = faqBase.data?.displayName;

  return (
    <div className="card rq-composer">
      {isReq && r.state === "NEEDS_INFO" ? (
        <Callout tone="warning" title={`${sp?.displayName || "The office"} needs more information`} description={ask ? <span translate="no">{clip(ask.text, 220)}</span> : undefined} />
      ) : null}
      <TextField className="field" value={text} onChange={(v) => (setText(v), err && setErr(""))} isInvalid={!!err}>
        <Label>{label}</Label>
        <TextArea id="rq-text" rows={3} placeholder={placeholder} translate="no" />
        <FieldError>{err}</FieldError>
      </TextField>
      {staff && !isReq && isQuestion(r) && kbName && faqPerms.can("items.create") ? (
        <SwitchRow
          title={`Add this answer to the ${course ? "course " : ""}FAQ`}
          description={`Saved to ${kbName} so the assistant can answer it next time.`}
          isSelected={faq}
          onChange={setFaq}
        />
      ) : null}
      <div className="rq-composer__actions">
        <div className="rq-composer__btns">{actions}</div>
      </div>
      <DeclineDialog
        isOpen={declining}
        first={first}
        initial={body}
        onClose={() => setDeclining(false)}
        onDecline={(reason) =>
          void run({ type: "deny", message: reason }, () => {
            setDeclining(false);
            toast(`Declined. ${first} will see your reason`);
          })
        }
        isPending={busy}
      />
    </div>
  );
}

function DeclineDialog({ isOpen, first, initial, onClose, onDecline, isPending }: { isOpen: boolean; first: string; initial: string; onClose: () => void; onDecline: (reason: string) => void; isPending: boolean }) {
  if (!isOpen) return null;
  return <DeclineForm first={first} initial={initial} onClose={onClose} onDecline={onDecline} isPending={isPending} />;
}

function DeclineForm({ first, initial, onClose, onDecline, isPending }: { first: string; initial: string; onClose: () => void; onDecline: (reason: string) => void; isPending: boolean }) {
  const [text, setText] = useState(initial);
  const [err, setErr] = useState("");
  const submit = () => {
    const reason = text.trim();
    if (!reason) return setErr("Add a reason so the requester knows what to do next.");
    onDecline(reason);
  };
  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={isPending}
      size="sm"
      title="Decline this request?"
      description={`${first} sees your reason and can send a new request.`}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" onPress={submit} isPending={isPending}>
            Decline
          </Button>
        </>
      }
    >
      <TextField className="field" value={text} onChange={(v) => (setText(v), err && setErr(""))} isRequired isInvalid={!!err}>
        <Label>Reason</Label>
        <TextArea rows={4} placeholder="For example: the re-grading window for this exam closed on Oct 28." autoFocus translate="no" />
        {err ? <FieldError>{err}</FieldError> : <Description>{" "}</Description>}
      </TextField>
    </KnowledgeModal>
  );
}

function ClosedNote({ request: r, space: sp, isReq, onAsk }: { request: Request; space: Space | null; isReq: boolean; onAsk: () => void }) {
  const st = requestStatus(r);
  const word = st === "completed" ? (isQuestion(r) ? "answered" : "completed") : st === "declined" ? "declined" : st === "withdrawn" ? "withdrawn" : "closed";
  const Icon = st === "declined" ? XCircle : st === "withdrawn" ? Undo2 : CheckCircle2;
  const action = !isReq ? null : isQuestion(r) && st === "completed" ? (
    sp ? (
      <Button size="sm" variant="secondary" onPress={onAsk}>
        <MessageCircle className="i" aria-hidden />
        Ask a follow-up
      </Button>
    ) : null
  ) : st !== "completed" && r.requestType ? (
    <LinkButton size="sm" href={`/requests/new?space=${resourceId(r.space)}&type=${resourceId(r.requestType)}`}>
      Send a new request
    </LinkButton>
  ) : null;
  return (
    <div className="rq-closed">
      <Icon className="i i-sm" aria-hidden />
      <span className="grow">
        This request was {word} {relIn(r.closeTime ?? r.updateTime)}.
      </span>
      {action}
    </div>
  );
}

/* ═══════════════ Side cards ═══════════════ */

function SideCards({
  request: r,
  type: t,
  space: sp,
  isReq,
  staff,
  canAssign,
  requesterName,
  requesterEmail,
  people,
  nameOf,
}: {
  request: Request;
  type: RequestType | null;
  space: Space | null;
  isReq: boolean;
  staff: boolean;
  canAssign: boolean;
  requesterName: string;
  requesterEmail?: string;
  people: Map<string, { name: string; roles: string[] }>;
  nameOf: (who: string | undefined) => string;
}) {
  const { member } = useWorkspace();
  const all = useRequests();
  const action = useRequestAction(resourceId(r.name));
  const answers = isQuestion(r) ? [] : (t?.fields ?? []).map((f) => [f.displayName || f.key, fieldText(f, (r.fields ?? {})[f.key])] as const);
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
          toast(assignee === member.name ? "Assigned to you" : assignee ? `Assigned to ${nameOf(assignee)}` : "Unassigned", {
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
        {r.assignee === member.name ? "You" : nameOf(r.assignee)}
      </span>
    </span>
  ) : (
    <span className="muted">Not assigned yet</span>
  );
  const assignCtl =
    staff && canAssign && isOpen(r) ? (
      <span className="row gap-4 none">
        {r.assignee !== member.name ? (
          <Button variant="tertiary" size="sm" onPress={() => assign(member.name ?? "")} isDisabled={action.isPending}>
            Assign to me
          </Button>
        ) : null}
        <Dropdown>
          <Dropdown.Trigger aria-label="Assign to someone else" className="button button--ghost button--sm button--icon-only button--muted">
            <Users className="i" aria-hidden />
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label="Assign to"
              selectionMode="single"
              selectedKeys={r.assignee ? [r.assignee] : []}
              onAction={(key) => assign(key === "__none__" ? null : String(key))}
            >
              <Dropdown.Section>
                <Dropdown.Item id="__label__" isDisabled textValue="Assign to">
                  <Label className="t-xs muted">Assign to</Label>
                </Dropdown.Item>
                {staffPeople.map(([name, p]) => (
                  <Dropdown.Item key={name} id={name} textValue={p.name}>
                    <Label translate="no">{p.name + (name === member.name ? " (you)" : "")}</Label>
                    <Description>{roleLabel(p.roles)}</Description>
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
              {r.assignee ? (
                <Dropdown.Section>
                  <Dropdown.Item id="__none__" textValue="Unassign">
                    <X className="i" aria-hidden />
                    <Label>Unassign</Label>
                  </Dropdown.Item>
                </Dropdown.Section>
              ) : null}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </span>
    ) : null;

  const others = (all.data ?? []).filter((x) => x.requester === r.requester && x.name !== r.name && isOpen(x)).length;
  const checks = sentCheckLines(r);

  return (
    <>
      <RqCard className="rq-side-card" title="Details">
        {answers.length ? (
          <>
            <dl className="rq-answers">
              {answers.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd translate="no">{v === "—" ? <span className="muted">—</span> : v}</dd>
                </div>
              ))}
            </dl>
            <Separator />
          </>
        ) : null}
        <KeyValue
          pairs={[
            ["Request", <span className="num">{shortId(r)}</span>],
            ["Sent to", <span translate="no">{sp?.displayName || "—"}</span>],
            ["Submitted", fmtDateTime(r.createTime)],
            isOpen(r) && r.dueTime ? (staff && !isReq ? ["SLA", <SlaText request={r} />] : ["Expected by", fmtDay(r.dueTime)]) : null,
            [
              "Assignee",
              <span className="rq-assignee">
                {assigneeNode}
                {assignCtl}
              </span>,
            ],
          ]}
        />
      </RqCard>
      {staff && !isReq ? (
        <RqCard className="rq-side-card" title="Requester">
          <div className="rq-person">
            <UserAvatar name={requesterName} size="lg" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="medium truncate" translate="no">
                {requesterName}
              </div>
              <div className="t-sm muted truncate">{requesterEmail ?? ""}</div>
            </div>
          </div>
          {others ? <KeyValue pairs={[["Other open", plural(others, "request")]]} /> : null}
        </RqCard>
      ) : null}
      {checks.length ? (
        <RqCard className="rq-side-card" title="Checked before sending" description={`The assistant checked these rules on ${fmtDateTime(r.createTime)}.`}>
          <RuleChecks lines={checks} />
        </RqCard>
      ) : null}
    </>
  );
}
