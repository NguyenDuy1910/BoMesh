"use client";

import { Button, Checkbox, FieldError, Input, Label, ListBox, Select, Spinner, TextArea, TextField } from "@heroui/react";
import { ChevronRight, ClipboardList, Clock, MessageCircle, Send, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout, EmptyState, ErrorState, ItemIcon, KeyValue, List, ListItem, NoMatches, Page, PageHeader, SearchInput, SkeletonRows, toast } from "@/components/ui";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { SpaceMark, useSpace } from "@/modules/spaces";

import { createRequest } from "../api";
import {
  capital,
  checkLines,
  initialValues,
  slaUsual,
  teamWord,
  toStruct,
  validateValues,
  type FieldValues,
  type Request,
  type RequestType,
  type RequestTypeField,
  type Space,
} from "../model";
import { useCatalog, useCreateRequest, useRequestType } from "../queries";
import { AskSpaceDialog } from "./AskSpaceDialog";
import { LinkButton, RqCard } from "./parts";
import { RuleChecks } from "./RuleChecks";

/** /requests/new — the catalog, or `?space=&type=` the form with the rule check (preview `P.requestNew`). */
export function NewRequestPage() {
  const params = useSearchParams();
  const space = params.get("space");
  const type = params.get("type");
  if (space && type) return <NewRequestForm key={`${space}/${type}`} spaceId={space} typeId={type} />;
  return <Catalog />;
}

/* ═══════════════ Catalog ═══════════════ */

function Catalog() {
  const { can } = useWorkspace();
  const catalog = useCatalog();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = catalog.groups
    .map((g) => ({
      space: g.space,
      types: g.types.filter((t) => !needle || [t.displayName, t.description, g.space.displayName].some((s) => (s ?? "").toLowerCase().includes(needle))),
    }))
    .filter((g) => g.types.length);
  const empty = (
    <EmptyState
      icon={ClipboardList}
      boxed
      title="No one takes requests here yet"
      description={can("spaces.create") ? "Offices and teams add request types in their space settings." : "When an office or team starts taking requests, you’ll find them here."}
      actions={<LinkButton href="/requests">Back to requests</LinkButton>}
    />
  );
  return (
    <Page narrow className="rq-page">
      <PageChrome crumbs={[{ label: "Requests", href: "/requests" }, { label: "New request" }]} />
      <PageHeader title="New request" description="Ask a team or office for something they handle. The assistant checks the rules before you send." />
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Search requests and offices" />
      </div>
      {catalog.isError && !catalog.groups.length ? (
        <ErrorState error={catalog.error} onRetry={catalog.refetch} />
      ) : catalog.isPending ? (
        <SkeletonRows rows={6} />
      ) : !catalog.groups.length ? (
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
            <LinkButton href="/requests/new" variant="primary">
              See all request types
            </LinkButton>
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

function FormBody({ type: t, space: sp }: { type: RequestType; space: Space }) {
  const { id } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const fields = t.fields ?? [];
  const rules = t.rules ?? [];
  const [vals, setVals] = useState<FieldValues>(() => initialValues(fields, params));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>(rules.length ? "checking" : "done");
  const [eligibility, setEligibility] = useState<Request["eligibility"] | null>(null);
  const [asking, setAsking] = useState(false);
  const create = useCreateRequest();
  const seq = useRef(0);
  const team = teamWord(sp);
  const lines = checkLines(rules, eligibility, team);
  const failing = lines.filter((c) => c.state === "fail");
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
  const usually = slaUsual(t);

  return (
    <Page narrow className="rq-page">
      <PageChrome
        crumbs={[
          { label: "Requests", href: "/requests" },
          { label: "New request", href: "/requests/new" },
          { label: t.displayName },
        ]}
      />
      <PageHeader lead={<SpaceMark space={sp} size={40} />} title={<span translate="no">{t.displayName}</span>} description={[sp.displayName, usually].filter(Boolean).join(" · ")} />
      <div className="rq-new">
        {rules.length ? (
          <RqCard
            className="rq-checkcard"
            title="Before you send"
            icon={<ItemIcon icon={ShieldCheck} tone="accent" size="sm" />}
            description={phase === "done" ? "The assistant checked the rules that apply to you. Select a number to read the source." : undefined}
          >
            {phase !== "done" ? (
              <>
                <div className="rq-checking" role="status">
                  <Spinner size="sm" />
                  <span>Checking the rules…</span>
                </div>
                <div className="stack gap-12 mt-4" aria-hidden>
                  {rules.map((_, i) => (
                    <span key={i} className="skeleton skeleton--line" style={{ width: `${[78, 62, 70][i % 3]}%` }} />
                  ))}
                </div>
              </>
            ) : (
              <>
                <RuleChecks lines={lines} />
                {failing.length ? (
                  <div className="mt-12">
                    <Callout
                      tone="danger"
                      title="You can’t send this request"
                      description={`${capital(team)} can still tell you what’s possible, for example whether an exception applies.`}
                      actions={
                        <Button variant="secondary" size="sm" onPress={() => setAsking(true)}>
                          <MessageCircle className="i" aria-hidden />
                          {`Ask ${team} instead`}
                        </Button>
                      }
                    />
                  </div>
                ) : null}
              </>
            )}
          </RqCard>
        ) : null}
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
          <div className="rq-summary">
            <KeyValue
              pairs={[
                ["Sent to", <span translate="no">{sp.displayName || "—"}</span>],
                usually ? ["Usually takes", usually.replace(/^Usually /, "")] : null,
              ]}
            />
          </div>
          <div className="rq-form__foot">
            <LinkButton href="/requests/new" variant="tertiary">
              Cancel
            </LinkButton>
            <Button variant="primary" onPress={send} isDisabled={phase !== "done" || failing.length > 0} isPending={create.isPending}>
              <Send className="i" aria-hidden />
              Send request
            </Button>
          </div>
        </RqCard>
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
        {error ? <div className="field-error" role="alert">{error}</div> : null}
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
