"use client";

import { Button, Card, Checkbox, FieldError, Input, Label, ListBox, Select, Spinner, TextArea, TextField } from "@heroui/react";
import { ArrowUpRight, ChevronRight, CircleAlert, ClipboardList, Clock, MessageCircle, Send, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout, Disclosure, EmptyState, ErrorState, ItemIcon, LinkButton, List, ListItem, NoMatches, Page, PageHeader, SearchInput, SkeletonRows, toast } from "@/components/ui";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useItem } from "@/modules/knowledge/queries";
import { SpaceMark, useSpace } from "@/modules/spaces";

import { createRequest } from "../api";
import {
  checkLines,
  initialValues,
  slaUsual,
  teamWord,
  toStruct,
  validateValues,
  type CheckLine,
  type FieldValues,
  type Request,
  type RequestType,
  type RequestTypeField,
  type Space,
} from "../model";
import { useCatalog, useCreateRequest, useRequestType } from "../queries";
import { AskSpaceDialog } from "./AskSpaceDialog";
import { ButtonLink, RqCard } from "./parts";
import { RuleChecks } from "./RuleChecks";

/** Preview list-tools rule (`needsTools`): search from 7 items, or while searching. */
const TOOLS_MIN = 7;

/**
 * /requests/new — the catalog (`?space=` scopes it to one space), or `?space=&type=` the form with the
 * rule check (preview `P.requestNew`). `?space=&ask` (old question links) opens the space's Ask dialog.
 */
export function NewRequestPage() {
  const params = useSearchParams();
  const space = params.get("space");
  const type = params.get("type");
  if (space && type) return <NewRequestForm key={`${space}/${type}`} spaceId={space} typeId={type} />;
  return <Catalog key={space ?? ""} spaceId={space ?? ""} />;
}

/* ═══════════════ Catalog ═══════════════ */

/** Service request types only; questions go through the space's Ask dialog. */
function Catalog({ spaceId }: { spaceId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const catalog = useCatalog();
  const askSpace = useSpace(params.has("ask") ? spaceId : "").data;
  const [asking, setAsking] = useState(params.has("ask"));
  const [q, setQ] = useState("");
  // From a space's page ("New request"), the catalog is that space's; the rest stays one link away.
  const scoped = spaceId ? catalog.groups.find((g) => resourceId(g.space.name) === spaceId) : undefined;
  const groups = scoped ? [scoped] : catalog.groups;
  const total = groups.reduce((n, g) => n + g.types.length, 0);
  const onlyType = scoped && scoped.types.length === 1 && !params.has("ask") ? scoped.types[0] : undefined;
  const needle = q.trim().toLowerCase();
  const shown = groups
    .map((g) => ({
      space: g.space,
      types: g.types.filter((t) => !needle || [t.displayName, t.description, g.space.displayName].some((s) => (s ?? "").toLowerCase().includes(needle))),
    }))
    .filter((g) => g.types.length);

  // A space that takes a single kind of request opens its form directly.
  useEffect(() => {
    if (onlyType) router.replace(`/requests/new?space=${spaceId}&type=${resourceId(onlyType.name)}`);
  }, [onlyType, router, spaceId]);

  const empty = (
    <EmptyState
      icon={ClipboardList}
      boxed
      title="No one takes requests here yet"
      description={can("spaces.create") ? "Office and team leads add request types in their space’s Settings, under Requests." : "When an office or team starts taking requests, you’ll find them here."}
      actions={<ButtonLink href="/requests">Back to requests</ButtonLink>}
    />
  );
  return (
    <Page narrow className="rq-page">
      <PageHeader
        title="New request"
        actions={
          scoped && catalog.groups.length > 1 ? (
            <ButtonLink href="/requests/new" variant="ghost">
              All request types
            </ButtonLink>
          ) : null
        }
        crumbs={[{ label: "Requests", href: "/requests" }, { label: "New request" }]}
      />
      {total >= TOOLS_MIN || q ? (
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Search requests and offices" />
        </div>
      ) : null}
      {catalog.isError && !catalog.groups.length ? (
        <ErrorState error={catalog.error} onRetry={catalog.refetch} />
      ) : catalog.isPending || onlyType ? (
        <SkeletonRows rows={6} />
      ) : !groups.length ? (
        empty
      ) : !shown.length ? (
        <NoMatches what="request types" onClear={() => setQ("")} />
      ) : (
        shown.map(({ space, types }) => (
          <section key={space.name} className="rq-group">
            <div className="rq-group__head">
              <SpaceMark space={space} size={32} />
              <div className="grow" style={{ minWidth: 0 }}>
                <h2 className="section__title truncate" translate="no">
                  {space.displayName}
                </h2>
                {space.description ? (
                  <p className="t-xs muted truncate" translate="no">
                    {space.description}
                  </p>
                ) : null}
              </div>
            </div>
            <List>
              {types.map((t) => (
                <ListItem
                  key={t.name}
                  lead={<ItemIcon icon={ClipboardList} />}
                  title={t.displayName}
                  contentTitle
                  description={
                    <>
                      <span className="rq-cat-desc" translate="no">
                        {t.description ?? ""}
                      </span>
                      {slaUsual(t) ? (
                        <span className="rq-cat-meta">
                          <Clock className="i i-sm" aria-hidden />
                          {slaUsual(t)}
                        </span>
                      ) : null}
                    </>
                  }
                  actions={<ChevronRight className="i muted" aria-hidden />}
                  href={`/requests/new?space=${resourceId(space.name)}&type=${resourceId(t.name)}`}
                />
              ))}
            </List>
          </section>
        ))
      )}
      {askSpace ? <AskSpaceDialog space={askSpace} isOpen={asking} onClose={() => setAsking(false)} initialQuestion={params.get("q") ?? ""} /> : null}
    </Page>
  );
}

/* ═══════════════ Form ═══════════════ */

function NewRequestForm({ spaceId, typeId }: { spaceId: string; typeId: string }) {
  const { id } = useWorkspace();
  const name = `workspaces/${id}/spaces/${spaceId}/requestTypes/${typeId}`;
  const type = useRequestType(name);
  const space = useSpace(spaceId);
  const crumbsBase = [
    { label: "Requests", href: "/requests" },
    { label: "New request", href: "/requests/new" },
  ];
  const gone = (type.isError && type.error instanceof ApiError && type.error.isNotFound) || type.data?.state === "DELETED" || (space.isError && space.error instanceof ApiError && space.error.isNotFound);
  if (gone)
    return (
      <Page>
        <PageChrome crumbs={[{ label: "Requests", href: "/requests" }, { label: "New request" }]} />
        <EmptyState
          icon={ClipboardList}
          boxed
          title="This request type isn’t available"
          description="It may have been removed by the office."
          actions={
            <ButtonLink href="/requests/new" variant="primary">
              See all request types
            </ButtonLink>
          }
        />
      </Page>
    );
  if ((type.isError && !type.data) || (space.isError && !space.data))
    return (
      <Page narrow>
        <PageChrome crumbs={crumbsBase} />
        <ErrorState error={type.error ?? space.error} onRetry={() => (void type.refetch(), void space.refetch())} />
      </Page>
    );
  if (!type.data || !space.data)
    return (
      <Page narrow>
        <PageChrome crumbs={crumbsBase} />
        <SkeletonRows rows={6} />
      </Page>
    );
  return <FormBody type={type.data} space={space.data} />;
}

type Phase = "checking" | "done";

/** Rules that are met fold into one line; only what blocks the request stays open (preview `metLine`). */
function MetLine({ lines }: { lines: readonly CheckLine[] }) {
  const met = lines.filter((c) => c.state === "pass").length;
  const know = lines.length - met;
  const summary = [met ? `${plural(met, "rule")} met` : "", know ? `${plural(know, "thing")} to know` : ""].filter(Boolean).join(" · ");
  return (
    <Disclosure icon={ShieldCheck} title="Rules the assistant checked" summary={summary}>
      <RuleChecks lines={lines} />
    </Disclosure>
  );
}

function FormBody({ type: t, space: sp }: { type: RequestType; space: Space }) {
  const { id } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const fields = t.fields ?? [];
  const rules = t.rules ?? [];
  const [vals, setVals] = useState<FieldValues>(() => initialValues(fields, params));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>(rules.length ? "checking" : "done");
  const [waitNote, setWaitNote] = useState(false);
  const [eligibility, setEligibility] = useState<Request["eligibility"] | null>(null);
  const [asking, setAsking] = useState(false);
  const create = useCreateRequest();
  const seq = useRef(0);
  const team = teamWord(sp);
  const lines = checkLines(rules, eligibility, team);
  const failing = lines.filter((c) => c.state === "fail");
  const ok = lines.filter((c) => c.state !== "fail");
  // A failed rule about the requester can't be fixed in the form, so the form waits; asking the office is the way forward.
  const hideForm = failing.some((c) => !c.fixable);
  const fixCite = failing.find((c) => c.cite)?.cite;
  const policy = useItem(fixCite);
  const struct = JSON.stringify(toStruct(fields, vals));

  // Server rule check (CreateRequest validateOnly) on open and as the details change.
  useEffect(() => {
    if (!rules.length) return;
    const n = ++seq.current;
    const timer = window.setTimeout(
      () => {
        createRequest(id, { kind: "SERVICE", requestType: t.name, fields: JSON.parse(struct) as Record<string, unknown> }, { validateOnly: true })
          .then((r) => n === seq.current && setEligibility(r.eligibility ?? { outcome: "PASS", results: [] }))
          .catch(() => n === seq.current && setEligibility(null))
          .finally(() => n === seq.current && setPhase("done"));
      },
      phase === "checking" ? 0 : 450,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-check only when the typed values change
  }, [struct]);

  const set = (key: string, value: string) => {
    setVals((v) => ({ ...v, [key]: value }));
    if (errs[key]) setErrs(({ [key]: _drop, ...rest }) => rest);
  };

  const send = () => {
    if (phase !== "done") return setWaitNote(true);
    const e = validateValues(fields, vals);
    setErrs(e);
    const bad = Object.keys(e);
    if (bad.length) {
      document.getElementById(`rq-f-${bad[0]}`)?.focus();
      return;
    }
    if (failing.length) return;
    create.mutate(
      { kind: "SERVICE", requestType: t.name, title: t.displayName, fields: toStruct(fields, vals) },
      {
        onSuccess: (r) => {
          toast(`Request sent to ${sp.displayName || "the office"}`);
          router.push(`/requests/${resourceId(r.name)}`);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.fieldViolations.length) {
            const next: Record<string, string> = {};
            for (const v of err.fieldViolations) if (v.field.startsWith("fields.")) next[v.field.slice(7)] = v.description;
            if (Object.keys(next).length) return setErrs(next);
          }
          if (err instanceof ApiError && err.reason === "REQUEST_NOT_ELIGIBLE") setPhase("checking");
          toast(errorMessage(err), { tone: "danger" });
        },
      },
    );
  };

  const askQuestion = `About “${t.displayName}”: ${failing[0]?.label ?? ""}. What are my options?`.replace(/\s+/g, " ").replace(/\.\./g, ".");

  let checkCard: ReactNode = null;
  if (rules.length && phase !== "done")
    checkCard = (
      <RqCard className="rq-checkcard">
        <div className="rq-checking" role="status">
          <Spinner size="sm" />
          <span>Checking the rules that apply to you…</span>
        </div>
      </RqCard>
    );
  else if (rules.length && !failing.length)
    checkCard = (
      <Card className="rq-checkcard rq-checkcard--ok">
        <MetLine lines={ok} />
      </Card>
    );
  else if (failing.length)
    // One red box: what blocks the request, then what to do about it.
    checkCard = (
      <RqCard className="rq-checkcard" title="Before you send" icon={<ItemIcon icon={ShieldCheck} tone="accent" size="sm" />}>
        <Callout
          tone="danger"
          title="You can’t send this request yet"
          description={failing.map((c) => c.consequence ?? c.detail).join(" ")}
          actions={
            <>
              <Button variant="secondary" size="sm" onPress={() => setAsking(true)}>
                <MessageCircle className="i" aria-hidden />
                {`Ask ${team} instead`}
              </Button>
              {fixCite && policy.data && policy.data.state !== "DELETED" ? (
                <LinkButton href={`/doc/${resourceId(fixCite)}`} icon={ArrowUpRight} size="sm">
                  Read the policy
                </LinkButton>
              ) : null}
            </>
          }
        />
        <div className="mt-12">
          <RuleChecks lines={failing} notes={false} />
        </div>
        {ok.length ? (
          <div className="mt-8">
            <MetLine lines={ok} />
          </div>
        ) : null}
      </RqCard>
    );

  return (
    <Page narrow className="rq-page">
      <PageHeader
        title={t.displayName}
        heading={<span translate="no">{t.displayName}</span>}
        lead={<SpaceMark space={sp} size={40} />}
        meta={[sp.displayName, slaUsual(t)].filter(Boolean).join(" · ")}
        crumbs={[
          { label: "Requests", href: "/requests" },
          { label: "New request", href: "/requests/new" },
          { label: t.displayName },
        ]}
      />
      <div className="rq-new">
        {checkCard}
        {hideForm ? null : (
          <RqCard className="rq-formcard" title="Details">
            {t.description ? (
              <p className="t-sm muted" translate="no">
                {t.description}
              </p>
            ) : null}
            <div className="rq-fields">
              {fields.map((f) => (
                <FieldControl key={f.key} field={f} value={vals[f.key] ?? ""} error={errs[f.key]} onChange={(v) => set(f.key, v)} />
              ))}
            </div>
            {/* Where it goes and how long it takes are in the header. */}
            <div className="rq-form__foot">
              {waitNote && phase !== "done" ? (
                <span className="rq-form__fee" role="status">
                  <Spinner size="sm" />
                  Still checking the rules. One moment.
                </span>
              ) : null}
              <ButtonLink href="/requests/new" variant="ghost">
                Cancel
              </ButtonLink>
              <Button variant="primary" onPress={send} isDisabled={failing.length > 0} isPending={create.isPending}>
                <Send className="i" aria-hidden />
                Send request
              </Button>
            </div>
          </RqCard>
        )}
      </div>
      <AskSpaceDialog space={sp} isOpen={asking} onClose={() => setAsking(false)} initialQuestion={askQuestion} about={`About ${t.displayName}`} />
    </Page>
  );
}

/** One request-type field (preview `fieldControl`). */
function FieldControl({ field: f, value, error, onChange }: { field: RequestTypeField; value: string; error?: string; onChange: (value: string) => void }) {
  const id = `rq-f-${f.key}`;
  const label = f.displayName || f.key;
  if (f.type === "SELECT")
    return (
      <Select className="field" id={id} value={value || null} onChange={(v) => onChange(v == null ? "" : String(v))} isRequired={f.required} isInvalid={!!error} placeholder="Choose…">
        <Label>{label}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {(f.options ?? []).map((o) => (
              <ListBox.Item key={o} id={o} textValue={o}>
                {o}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
        <FieldError>{error}</FieldError>
      </Select>
    );
  if (f.type === "BOOLEAN")
    return (
      <div className="field">
        <Checkbox id={id} isSelected={value === "true"} onChange={(on) => onChange(on ? "true" : "false")} isInvalid={!!error}>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Checkbox.Content>
            <Label>{label}</Label>
          </Checkbox.Content>
        </Checkbox>
        {error ? (
          <div className="field-error" role="alert">
            <CircleAlert className="i" aria-hidden />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    );
  return (
    <TextField className="field" id={id} value={value} onChange={onChange} isRequired={f.required} isInvalid={!!error}>
      <Label>{label}</Label>
      {f.type === "TEXT" ? (
        <TextArea rows={3} />
      ) : (
        <Input type={f.type === "NUMBER" ? "number" : f.type === "DATE" ? "date" : "text"} inputMode={f.type === "NUMBER" ? "numeric" : undefined} style={f.type === "NUMBER" || f.type === "DATE" ? { maxWidth: f.type === "NUMBER" ? 140 : 200 } : undefined} />
      )}
      <FieldError>{error}</FieldError>
    </TextField>
  );
}
