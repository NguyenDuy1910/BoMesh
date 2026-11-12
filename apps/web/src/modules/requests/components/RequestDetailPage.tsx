"use client";

import { Button, Checkbox, Description, Dropdown, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { ArrowRight, BookOpen, Check, CheckCircle2, ClipboardList, Clock, Eye, Lock, MessageCircle, MoreHorizontal, Send, Sparkles, Undo2, Users, X, XCircle } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { confirm, EmptyState, ErrorState, ItemIcon, KeyValue, Page, PageHeader, SkeletonRows, SwitchRow, toast, UserAvatar } from "@/components/ui";
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
import { useDecider, useRequest, useRequestAction, useRequestMessages, useRequests, useRequestType, type DeciderPermission, type RequestAction } from "../queries";
import { AskSpaceDialog } from "./AskSpaceDialog";
import { ButtonLink, RqCard } from "./parts";
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
              <ButtonLink href="/requests" variant="primary">
                Go to requests
              </ButtonLink>
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

type People = Map<string, { name: string; roles: string[] }>;

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

  const people: People = new Map();
  for (const m of spaceMembers.data ?? []) if (m.member) people.set(m.member, { name: m.displayName ?? "", roles: m.roles ?? [] });
  const requesterName = requester?.displayName || people.get(r.requester ?? "")?.name || "Someone";
  const nameOf = (who: string | undefined) => (who === r.requester ? requesterName : (people.get(who ?? "")?.name ?? (who === member.name ? (member.displayName ?? "You") : "Someone")));
  const title = requestTitle(r, type);

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

  // Where it was sent and when it's due sit under the title; the request ID is in the trail.
  const sub: ReactNode[] = [
    isQuestion(r) ? "Question" : null,
    sp?.displayName ? <span translate="no">{sp.displayName}</span> : null,
    isOpen(r) && r.dueTime ? staff && !isReq ? <SlaText request={r} /> : `Expected by ${fmtDay(r.dueTime)}` : null,
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
              <Dropdown.Trigger aria-label="More" className="button button--ghost button--icon-only button--muted">
                <MoreHorizontal className="i" aria-hidden />
              </Dropdown.Trigger>
              <Dropdown.Popover placement="bottom end">
                <Dropdown.Menu aria-label="More" onAction={(key) => key === "withdraw" && void withdraw()}>
                  <Dropdown.Item id="withdraw" textValue="Withdraw request" variant="danger">
                    <Undo2 className="i" aria-hidden />
                    <Label>Withdraw request</Label>
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          ) : undefined
        }
        crumbs={[{ label: "Requests", href: staff && !isReq ? "/requests?tab=queue" : "/requests" }, { label: shortId(r) }]}
      />
      <div className="rq-detail">
        <div className="rq-main">
          <Thread request={r} type={type} space={sp} messages={messages.data ?? []} isPending={messages.isPending} isError={messages.isError} onRetry={() => void messages.refetch()} nameOf={nameOf} people={people} />
          <Composer request={r} space={sp} isReq={isReq} staff={staff} can={decider.can} requesterName={requesterName} assigneeName={r.assignee ? nameOf(r.assignee) : undefined} onAsk={() => setAsking(true)} />
        </div>
        <aside className="rq-side" aria-label="Request details">
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
  const you = (who: string | undefined) => (who === member.name ? "You" : nameOf(who));
  const lastStaff = [...messages].reverse().find((m) => m.author !== r.requester);
  // What was asked sits right under "submitted": staff read it before they decide, requesters see what they sent.
  const answers = isQuestion(r) ? [] : (t?.fields ?? []).map((f) => [f.displayName || f.key, fieldText(f, (r.fields ?? {})[f.key])] as const);
  const entries: Entry[] = [];
  entries.push({
    key: "submitted",
    at: r.createTime ?? "",
    node: (
      <>
        <Event icon={Send} who={you(r.requester)} text={isQuestion(r) ? `asked ${teamWord(sp)}` : "submitted this request"} at={r.createTime} />
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
      <span className="truncate">{course ? "Added to the course FAQ" : "Added to the FAQ"}</span>
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
    if (!body) return need("Write a message first.");
    void run({ type: "message", text: body }, () => toast(isReq ? `Sent. ${assigneeName || "The office"} will see it in their queue` : `Sent to ${requesterName}`));
  };
  const askInfo = () => {
    if (!body) return need(`Say what you need from ${requesterName}.`);
    void run({ type: "sendBack", message: body }, () => toast(`Asked ${requesterName} for information. The SLA clock pauses until they reply`));
  };
  const approve = () => void run({ type: "approve", message: body || undefined }, () => toast(`Approved. ${requesterName} will be notified`));
  const kbName = faqCollection.data?.displayName;
  const canFaq = staff && !isReq && isQuestion(r) && !!kbName && faqPerms.can("items.create");
  const answer = () => {
    if (!body) return need("Write the answer first.");
    const publish = faq && canFaq ? faqTarget : undefined;
    void run({ type: "answer", answer: body, publishToCollection: publish }, (updated) => {
      const doc = updated?.faqItem;
      if (doc) toast(course ? "Answer sent and added to the course FAQ" : "Answer sent and added to the FAQ", { action: { label: "Open FAQ", onPress: () => router.push(faqHref(doc, body)) } });
      else toast(`Answer sent to ${requesterName}`);
    });
  };

  const send = (variant: "primary" | "secondary") => (
    // Staff Send: a plain message, or — with "Ask … for information" ticked — a request for information that pauses the SLA.
    <Button variant={variant} onPress={asking ? askInfo : reply} isPending={busy}>
      <Send className="i" aria-hidden />
      Send
    </Button>
  );
  let label: string;
  let placeholder: string;
  let decide: ReactNode;
  if (isReq) {
    label = needsInfo ? "Your reply" : "Add a message";
    placeholder = needsInfo ? "Answer the question above." : `Add details for ${sp?.displayName || "the office"}.`;
    // Prominent only when the office is waiting on the requester; otherwise there's nothing to do but wait.
    decide = (
      <Button variant={needsInfo ? "primary" : "secondary"} onPress={reply} isPending={busy}>
        <Send className="i" aria-hidden />
        {needsInfo ? "Send reply" : "Send"}
      </Button>
    );
  } else if (isQuestion(r)) {
    label = "Your answer";
    placeholder = asking ? `What do you need from ${requesterName}?` : `Answer ${requesterName}. Cite the slide or document if you can.`;
    decide =
      asking || !can("requests.answer") ? (
        send("primary")
      ) : (
        <Button variant="primary" onPress={answer} isPending={busy}>
          <Send className="i" aria-hidden />
          Answer
        </Button>
      );
  } else if (asking) {
    label = `Message to ${requesterName}`;
    placeholder = `What do you need from ${requesterName}?`;
    decide = send("primary");
  } else {
    label = `Message to ${requesterName}`;
    placeholder = `Write to ${requesterName}, or add a note to your decision.`;
    decide = (
      <>
        {send("secondary")}
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

  return (
    <div className="card rq-composer">
      <TextField className="field" value={text} onChange={(v) => (setText(v), err && setErr(""))} isInvalid={!!err}>
        <Label>{label}</Label>
        <TextArea id="rq-text" rows={3} placeholder={placeholder} translate="no" />
        <FieldError>{err}</FieldError>
      </TextField>
      {canFaq && !asking ? (
        <SwitchRow
          title={course ? "Add this answer to the course FAQ" : "Add this answer to the FAQ"}
          description={`Saved to ${kbName} so the assistant can answer it next time.`}
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
                {`Ask ${requesterName} for information`} <span className="muted">(pauses the SLA)</span>
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
            toast(`Declined. ${requesterName} will see your reason`);
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
    if (!reason) return setErr("Add a reason so the requester knows what to do next.");
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
      title="Decline this request?"
      description={`${requester} sees your reason and can send a new request.`}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" onPress={submit} isPending={isPending}>
            <XCircle className="i" aria-hidden />
            Decline request
          </Button>
        </>
      }
    >
      <TextField className="field" value={text} onChange={(v) => (setText(v), err && setErr(""))} isRequired isInvalid={!!err}>
        <Label>Reason</Label>
        <TextArea rows={4} placeholder="For example: this needs sign-off from your manager first." autoFocus translate="no" />
        {err ? <FieldError>{err}</FieldError> : <Description>Say why, and what they can do instead.</Description>}
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
    <ButtonLink size="sm" href={`/requests/new?space=${resourceId(r.space)}&type=${resourceId(r.requestType)}`}>
      Send a new request
    </ButtonLink>
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
  const all = useRequests();
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
            <Dropdown.Menu aria-label="Assign to" selectionMode="single" selectedKeys={r.assignee ? [r.assignee] : []} onAction={(key) => assign(key === "__none__" ? null : String(key))}>
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
        <KeyValue
          pairs={[
            ["Submitted", fmtDateTime(r.createTime)],
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
