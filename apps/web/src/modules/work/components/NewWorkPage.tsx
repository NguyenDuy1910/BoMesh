"use client";

import { Button, FieldError, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { AlertCircle, ArrowLeft, Check, Layers, Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout, EmptyState, Page, PageHeader, SkeletonRows, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useMySpaces } from "@/modules/spaces";

import { useStartWork } from "../actions";
import { isSpaceStaff, runsWithoutSpace, spaceFits, workflowOf, workflowsFor, type WorkflowId } from "../kinds";
import { criteriaOf, defaultTitle, generationInstructions, optionOf, withDraftDefaults, type Recipe, type WorkOptions } from "../model";
import { isUsableDoc, useMaterialDocs, usePassedDocs, withPassedDocs } from "../queries";
import { MaterialsPicker } from "./MaterialsPicker";
import { NewWorkOptions } from "./NewWorkOptions";
import { FirstRun, FlowCards } from "./WorkFlows";

const NO_SPACE = "-";

/** `/work/new` — what → from which materials → options + title → Generate (preview `P.workNew`). */
export function NewWorkPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { settings, hasModule } = useWorkspace();
  const spacesOn = hasModule("spaces");
  const mySpacesQuery = useMySpaces();
  const mySpaces = useMemo(() => (spacesOn ? (mySpacesQuery.data ?? []) : []), [mySpacesQuery.data, spacesOn]);
  const scope = { mySpaces, spacesOn };
  const flows = workflowsFor(settings, null, scope);
  const startWork = useStartWork();

  const [workflow, setWorkflow] = useState<WorkflowId | "">("");
  const [spaceId, setSpaceId] = useState("");
  const [docs, setDocs] = useState<Set<string>>(new Set());
  /** Documents passed in `docs` (bare IDs): always listed and preselected, whatever space is browsed. */
  const [passedIds, setPassedIds] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [chosen, setOpts] = useState<WorkOptions>({});
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [step, setStep] = useState(1);
  const [err, setErr] = useState("");
  const [titleErr, setTitleErr] = useState("");
  const [busy, setBusy] = useState(false);
  /** URL prefill (`workflow`, `space`, `docs`, `title`), applied once the spaces and materials are known. */
  const prefill = useRef<{ toOptions: boolean } | null>(null);
  const inited = useRef(false);

  const wf = workflow ? workflowOf(workflow, mySpaces.find((s) => resourceId(s.name) === spaceId), scope) : null;
  const spacesFor = (id: WorkflowId) => mySpaces.filter((s) => spaceFits(id, s));
  const space = mySpaces.find((s) => resourceId(s.name) === spaceId) ?? null;
  const staffQuiz = workflow === "QUIZ" && isSpaceStaff(space);
  const privateFlow = workflow === "STUDY_GUIDE" || (workflow === "QUIZ" && !staffQuiz);
  const materials = useMaterialDocs(space, { mine: privateFlow, enabled: !!workflow && step >= 2 && (!!space || spaceId === NO_SPACE) });
  const passed = usePassedDocs(passedIds);
  const groups = useMemo(() => withPassedDocs(materials.data, passed.data), [materials.data, passed.data]);
  const passedPending = passedIds.length > 0 && passed.isPending;
  const allDocs = useMemo(() => (groups ?? []).flatMap((g) => g.docs), [groups]);
  const picked = allDocs.filter((d) => docs.has(d.name ?? "") && isUsableDoc(d));
  const opts = wf?.kind === "DRAFT" ? withDraftDefaults(chosen, space?.spaceType, picked.map((d) => d.displayName ?? "")) : chosen;
  /** On a space change, the selection keeps only the passed documents (they belong to no space). */
  const keepPassed = (prev: Set<string>) => new Set([...prev].filter((n) => passedIds.includes(resourceId(n))));
  const sources = workflow === "EVIDENCE_REVIEW" ? picked.slice(0, opts.maxPapers ?? 6) : picked;

  const titleFor = (o: WorkOptions = opts) =>
    wf ? defaultTitle(wf.kind, { spaceName: space?.displayName, docNames: picked.map((d) => d.displayName ?? ""), options: o, staffQuiz }) : "";

  /* Choose a space for a workflow: keep the current one when it fits, else the first. */
  const spaceForFlow = (id: WorkflowId, wanted?: string) => {
    const fits = spacesFor(id);
    if (wanted && fits.some((s) => resourceId(s.name) === wanted)) return wanted;
    if (fits.some((s) => resourceId(s.name) === spaceId)) return spaceId;
    if (fits[0]) return resourceId(fits[0].name);
    return runsWithoutSpace(id, spacesOn) ? NO_SPACE : "";
  };

  /* Prefill from the URL once the caller's spaces are known. */
  useEffect(() => {
    if (inited.current || (spacesOn && mySpacesQuery.isPending)) return;
    inited.current = true;
    const want = params.get("workflow") ?? "";
    const titleParam = params.get("title") ?? "";
    if (titleParam) {
      setTitle(titleParam);
      setTitleTouched(true);
    }
    if (!flows.some((f) => f.id === want)) return;
    const id = want as WorkflowId;
    setWorkflow(id);
    setSpaceId(spaceForFlow(id, params.get("space") ?? undefined));
    setStep(2);
    const docIds = (params.get("docs") ?? "").split(",").filter(Boolean);
    setPassedIds(docIds);
    prefill.current = { toOptions: !!docIds.length && !!params.get("space") };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time prefill
  }, [mySpacesQuery.isPending, spacesOn]);

  /* Preselect the passed documents once they and the materials load (only those the caller can use). */
  useEffect(() => {
    const p = prefill.current;
    if (!p || !groups || passedPending) return;
    prefill.current = null;
    const usable = new Map(allDocs.filter(isUsableDoc).map((d) => [resourceId(d.name), d.name ?? ""]));
    const next = new Set(passedIds.map((d) => usable.get(d)).filter((n): n is string => !!n));
    setDocs(next);
    if (p.toOptions && next.size) setStep(3);
  }, [allDocs, groups, passedIds, passedPending]);

  /* Default title on reaching the options step (until the person types one). */
  useEffect(() => {
    if (step === 3 && !titleTouched) setTitle(titleFor());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed on the inputs below
  }, [step, titleTouched, workflow, spaceId, docs, opts.type]);

  const pickFlow = (id: WorkflowId) => {
    if (id !== workflow) {
      setWorkflow(id);
      setOpts({});
      if (!titleTouched) setTitle("");
      const next = spaceForFlow(id);
      if (next !== spaceId) {
        setSpaceId(next);
        setDocs(keepPassed);
      }
    }
    setStep(2);
    setErr("");
  };
  const goStep = (n: number) => {
    setStep(n);
    setErr("");
    setTitleErr("");
  };
  const next = () => {
    if (!picked.length) {
      setErr("Pick at least one document.");
      return;
    }
    goStep(3);
  };
  const cancel = () => {
    if (window.history.length > 1) router.back();
    else router.push("/work");
  };
  const generate = async () => {
    if (!wf || busy) return;
    const t = title.trim();
    if (!t) {
      setTitleErr("Give it a title.");
      return;
    }
    if (!sources.length) {
      goStep(2);
      setErr("Pick at least one document.");
      return;
    }
    if (wf.kind === "EVIDENCE_REVIEW" && opts.criteria?.length === 0) {
      toast("Pick at least one criterion to compare.", { tone: "danger" });
      return;
    }
    const recipe: Recipe = {
      kind: wf.kind,
      workflow: wf.id,
      title: t,
      space: space?.name,
      sources: sources.map((d) => d.name ?? ""),
      instructions: generationInstructions(wf.kind, opts, { staffQuiz }),
      ...(wf.kind === "EVIDENCE_REVIEW" ? { options: sources.map(optionOf), criteria: criteriaOf(opts.criteria ?? ["Method", "Dataset", "Result", "Limitations"]) } : {}),
    };
    setBusy(true);
    try {
      await startWork(recipe, { replace: true });
    } catch (e) {
      setBusy(false);
      toast(errorMessage(e), { tone: "danger" });
    }
  };

  const crumbs = <PageChrome crumbs={[{ label: "Work", href: "/work" }, { label: "New" }]} />;
  if (spacesOn && mySpacesQuery.isPending)
    return (
      <Page narrow className="work-new">
        {crumbs}
        <PageHeader title="New work" />
        <SkeletonRows rows={4} />
      </Page>
    );

  const cancelBtn = (
    <Button variant="ghost" onPress={cancel}>
      Cancel
    </Button>
  );
  const backBtn = (n: number) => (
    <Button variant="tertiary" onPress={() => goStep(n)}>
      <ArrowLeft className="i" aria-hidden />
      Back
    </Button>
  );

  let body: React.ReactNode;
  let foot: React.ReactNode;
  if (step === 1 || !wf) {
    body = (
      <>
        <h2 className="work-q">What do you want to make?</h2>
        {flows.length ? <FlowCards flows={flows} onPick={pickFlow} /> : <FirstRun flows={flows} />}
      </>
    );
    foot = <div className="work-new__foot">{cancelBtn}</div>;
  } else if (step === 2) {
    const fits = spacesFor(wf.id);
    const choices = [
      ...(runsWithoutSpace(wf.id, spacesOn) ? [{ id: NO_SPACE, label: "No space — any knowledge I can read" }] : []),
      ...fits.map((s) => ({ id: resourceId(s.name), label: s.displayName })),
    ];
    body = (
      <>
        <h2 className="work-q">From which materials?</h2>
        {choices.length && spacesOn ? (
          <Select
            className="field"
            value={spaceId || null}
            onChange={(v) => {
              setSpaceId(String(v));
              setDocs(keepPassed);
              setQ("");
              setErr("");
            }}
          >
            <Label>Space</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {choices.map((c) => (
                  <ListBox.Item key={c.id} id={c.id} textValue={c.label}>
                    <span translate={c.id === NO_SPACE ? undefined : "no"}>{c.label}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        ) : null}
        <div className="field mt-16">
          <span className="label">
            Documents<span className="label__req" aria-hidden="true">*</span>
          </span>
          {!choices.length ? (
            <EmptyState
              icon={Layers}
              title={`No space where you can make a ${wf.label.toLowerCase()}`}
              description="Join a space first. Its materials are what the assistant works from."
              actions={<Button onPress={() => router.push("/spaces")}>Browse spaces</Button>}
              boxed
              compact
            />
          ) : (
            <MaterialsPicker
              groups={groups}
              isPending={materials.isPending || passedPending}
              error={materials.error ?? passed.error}
              onRetry={() => void (materials.error ? materials.refetch() : passed.refetch())}
              selected={docs}
              onChange={(n) => {
                setDocs(n);
                setErr("");
              }}
              q={q}
              onQ={setQ}
              spaceName={space?.displayName}
            />
          )}
          {err ? (
            <div className="field-error" role="alert">
              <AlertCircle className="i" aria-hidden />
              <span>{err}</span>
            </div>
          ) : null}
        </div>
      </>
    );
    foot = (
      <div className="work-new__foot">
        {backBtn(1)}
        <span className="grow" />
        {cancelBtn}
        <Button variant="primary" onPress={next} isDisabled={!choices.length}>
          Continue
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        <h2 className="work-q">Set it up</h2>
        <div className="work-new__picked">
          <span className="t-sm">
            {plural(sources.length, "document")}
            {space ? (
              <>
                {" from "}
                <span translate="no">{space.displayName}</span>
              </>
            ) : null}
          </span>
          <button type="button" className="link-button" onClick={() => goStep(2)}>
            Change
          </button>
        </div>
        <div className="work-new__opts">
          <NewWorkOptions
            kind={wf.kind}
            opts={opts}
            staffQuiz={staffQuiz}
            onChange={(patch) => {
              const o = { ...opts, ...patch };
              setOpts(o);
              if (patch.type && !titleTouched) setTitle(titleFor(o));
            }}
          />
        </div>
        <TextField
          className="field"
          value={title}
          onChange={(v) => {
            setTitle(v);
            setTitleTouched(true);
            setTitleErr("");
          }}
          isInvalid={!!titleErr}
          isRequired
        >
          <Label>Title</Label>
          <Input
            translate="no"
            onKeyDown={(e) => {
              if (e.key === "Enter") void generate();
            }}
          />
          <FieldError>{titleErr}</FieldError>
        </TextField>
        {workflow === "EVIDENCE_REVIEW" && picked.length > sources.length ? (
          <div className="mt-16">
            <Callout description={`Only the first ${plural(sources.length, "document")} are compared. Raise “Sources at most” or pick fewer.`} />
          </div>
        ) : null}
      </>
    );
    foot = (
      <div className="work-new__foot">
        {backBtn(2)}
        <span className="grow" />
        {cancelBtn}
        <Button variant="primary" onPress={() => void generate()} isPending={busy}>
          <Sparkles className="i" aria-hidden />
          Generate
        </Button>
      </div>
    );
  }

  const steps: [string, string][] = [
    ["Type", wf?.label ?? ""],
    ["Materials", step > 2 ? plural(sources.length, "document") : ""],
    ["Options", ""],
  ];

  return (
    <Page narrow className="work-new">
      {crumbs}
      <PageHeader title={wf ? wf.label : "New work"} />
      {wf ? (
        <ol className="work-steps" aria-label="Steps">
          {steps.map(([label, meta], i) => {
            const s = i + 1;
            const state = s < step ? "is-done" : s === step ? "is-current" : "";
            const inner = (
              <>
                <span className="work-steps__dot">{s < step ? <Check className="i" aria-hidden /> : s}</span>
                <span className="work-steps__text">
                  <span className="work-steps__label">{label}</span>
                  {meta ? <span className="work-steps__meta truncate">{meta}</span> : null}
                </span>
              </>
            );
            return [
              i ? <li key={`l${s}`} className="work-steps__line" aria-hidden="true" /> : null,
              <li key={s} className={`work-steps__item ${state}`} aria-current={s === step ? "step" : undefined}>
                {s < step ? (
                  <button type="button" className="work-steps__btn" onClick={() => goStep(s)}>
                    {inner}
                  </button>
                ) : (
                  <span className="work-steps__btn">{inner}</span>
                )}
              </li>,
            ];
          })}
        </ol>
      ) : null}
      <div className="card card--lg work-new__card">
        {body}
        {foot}
      </div>
    </Page>
  );
}
