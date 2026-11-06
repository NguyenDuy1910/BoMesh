"use client";

import { Button, Card, Checkbox, Chip, Description, FieldError, Input, Label, Modal, Radio, RadioGroup, Spinner, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, ChevronDown, ChevronRight, CircleAlert, ExternalLink, FileText, Folder, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";

import { AppIcon, Callout, ChoiceGroup, EmptyState, ErrorState, KeyValue, SearchInput, SkeletonRows, toast } from "@/components/ui";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { createBase } from "@/modules/knowledge/bases/api";
import { knowledgeKeys } from "@/modules/knowledge/queries";

import { connectConfluence, isCancelled, signInAgain, signInNew, TokenRejected } from "../accounts";
import { browseResources, createSource, requestConnector, type Connection, type Connector, type PublishingPolicy } from "../api";
import { addChildren, checkState, EMPTY_TREE, matches, pathOf, ROOT, sourceNameFor, toggleSelection, type ContentNode, type ContentTree } from "../content-tree";
import { confluenceErrors, connectedConfluenceHosts, EMPTY_CONFLUENCE, type ConfluenceErrors } from "../connect-form";
import { accountLabel, appKey, appName, POLICY_CHOICES, providerOf, sourceName } from "../model";
import { closeIngestionOverlay, type WizardOptions } from "../overlays";
import { useConnections, useConnectors, useInvalidateIngestion, useMyConnectorRequests, useSources } from "../queries";
import { DEFAULT_DRAFT, scheduleFor, type ScheduleDraft } from "../schedule";
import { CONFLUENCE, ConfluenceFields, revalidate, usePendingSignIn, WaitingState } from "./AccountDialogs";
import { OptionSelect, ScheduleFields } from "./ScheduleFields";
import { useBaseIndex } from "./shared";

const STEPS = ["App", "Account", "Content", "Destination"] as const;
const NEW_ACCOUNT = "new";
const NEW_BASE = "__new";

/**
 * Connect a source (preview `M['src-wizard']`): App → Account → Content (tri-state
 * tree from `:browseResources`) → Destination with schedule and publishing policy.
 * Each picked folder/space becomes one Source (the API syncs one external resource
 * per source); creating it starts the first sync.
 */
export function ConnectWizard({ options }: { options: WizardOptions }) {
  const { id } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const refresh = useInvalidateIngestion();
  const connectors = useConnectors();
  const connections = useConnections();
  const sources = useSources();
  const bases = useBaseIndex();
  const requests = useMyConnectorRequests();

  const [step, setStep] = useState(options.connection ? 3 : options.connector ? 2 : 1);
  const [app, setApp] = useState(options.connector ?? "");
  const [account, setAccount] = useState(options.connection ?? "");
  const [conf, setConf] = useState(EMPTY_CONFLUENCE);
  const [confErrors, setConfErrors] = useState<ConfluenceErrors>({});
  const [waiting, setWaiting] = useState<"" | "new" | string>("");
  const [signInError, setSignInError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false);
  const pending = usePendingSignIn();

  const [tree, setTree] = useState<ContentTree>(EMPTY_TREE);
  const [treeFor, setTreeFor] = useState("");
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState<{ node: string; error: unknown } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [selErr, setSelErr] = useState("");

  const [kb, setKb] = useState(options.kb ?? "");
  const [kbName, setKbName] = useState("");
  const [errors, setErrors] = useState<{ kb?: string; kbName?: string }>({});
  const [draft, setDraft] = useState<ScheduleDraft>(DEFAULT_DRAFT);
  const [policy, setPolicy] = useState<PublishingPolicy>("REVIEW_FIRST");

  const accounts = (connections.data ?? []).filter((c) => c.connector === app && c.state !== "AUTHORIZING");
  const hosts = connectedConfluenceHosts(connections.data ?? []);
  const provider = providerOf(app);
  const isGoogle = app === "connectors/google_drive";
  const noun = isGoogle ? "folders" : "spaces and pages";

  // Preselect a usable account when the app changes.
  useEffect(() => {
    if (!app || step !== 2 || account) return;
    const ok = accounts.find((c) => c.state === "ACTIVE");
    setAccount(ok?.name ?? (accounts.length ? "" : NEW_ACCOUNT));
  }, [app, step, account, accounts]);

  // Valid preselected destination only.
  useEffect(() => {
    if (kb && kb !== NEW_BASE && bases.data && !bases.targets.some((b) => b.name === kb)) setKb("");
  }, [kb, bases.data, bases.targets]);

  async function loadLevel(nodeId: string, path: string) {
    setLoading((s) => new Set(s).add(nodeId));
    setLoadError(null);
    try {
      const resources = await browseResources(id, account, path);
      const nodes: ContentNode[] = resources.map((r) => ({ id: r.resourceId ?? r.path ?? "", name: r.displayName ?? r.resourceId ?? "", type: r.type ?? "", path: r.path ?? r.resourceId ?? "", hasChildren: !!r.hasChildren }));
      setTree((t) => addChildren(t, nodeId, nodes));
    } catch (error) {
      setLoadError({ node: nodeId, error });
    } finally {
      setLoading((s) => {
        const next = new Set(s);
        next.delete(nodeId);
        return next;
      });
    }
  }

  // Entering Content with a (new) account loads the top level.
  useEffect(() => {
    if (step !== 3 || !account || account === NEW_ACCOUNT || treeFor === account) return;
    setTreeFor(account);
    setTree(EMPTY_TREE);
    setSelection([]);
    setOpen(new Set());
    setQ("");
    void loadLevel(ROOT, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, account, treeFor]);

  const goto = (n: number) => {
    setStep(n);
    setAsk(false);
    setSelErr("");
    setSignInError("");
  };

  const dirty = step > 1 && !(options.connector && step === 2) && !(options.connection && step === 3 && !selection.length);
  const close = () => {
    if (waiting) return pending.current?.cancel();
    if (busy) return;
    if (ask) return setAsk(false);
    if (!dirty) return closeIngestionOverlay();
    setAsk(true);
  };

  /* ── Account step ── */

  async function signIn(existing?: Connection) {
    setSignInError("");
    try {
      pending.current = existing ? signInAgain(id, existing) : signInNew(id, app);
    } catch (error) {
      setSignInError(errorMessage(error));
      return;
    }
    setWaiting(existing?.name ?? "new");
    try {
      const connection = await pending.current.done;
      refresh();
      setAccount(connection.name ?? "");
      if (existing) toast(`${appName(app)} reconnected`);
      else {
        toast(`Connected ${accountLabel(connection)}`);
        goto(3);
      }
    } catch (error) {
      if (error instanceof ApiError) setSignInError(errorMessage(error));
      else if (!isCancelled(error)) setSignInError(`${provider} didn’t confirm the sign-in. Try again, or use a different account.`);
    } finally {
      pending.current = null;
      setWaiting("");
    }
  }

  async function verifyConfluence() {
    const found = confluenceErrors(conf, hosts);
    setConfErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const connection = await connectConfluence(id, conf);
      refresh();
      setConf(EMPTY_CONFLUENCE);
      setAccount(connection.name ?? "");
      toast(`Connected ${accountLabel(connection)}`);
      goto(3);
    } catch (error) {
      setConfErrors({ token: error instanceof TokenRejected ? error.message : errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  /* ── Submit ── */

  const picked = useMemo(() => selection.filter((s) => tree.nodes[s]), [selection, tree]);

  function kbNameError(v: string): string {
    const n = v.trim();
    if (!n) return "Name the new knowledge base.";
    if ((bases.data ?? []).some((b) => (b.displayName ?? "").trim().toLowerCase() === n.toLowerCase())) return "A knowledge base with this name already exists.";
    return "";
  }

  async function submit() {
    const next: typeof errors = {};
    if (!kb) next.kb = "Choose where documents go.";
    if (kb === NEW_BASE) {
      const e = kbNameError(kbName);
      if (e) next.kbName = e;
    }
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      let target = kb;
      if (kb === NEW_BASE) {
        const base = await createBase(id, { displayName: kbName.trim(), discoverable: true });
        target = base.name ?? "";
        void qc.invalidateQueries({ queryKey: knowledgeKeys.items(id) });
      }
      const taken = (sources.data ?? []).map(sourceName);
      const created = [];
      for (const nodeId of picked) {
        const node = tree.nodes[nodeId]!;
        const displayName = sourceNameFor(tree, nodeId, appKey(app), taken);
        taken.push(displayName);
        created.push(
          await createSource(id, {
            connection: account,
            targetCollection: target,
            externalResource: { type: node.type, resourceId: node.id, displayName: pathOf(tree, nodeId) },
            displayName,
            schedule: scheduleFor(draft),
            publishingPolicy: policy,
          }),
        );
      }
      refresh();
      closeIngestionOverlay();
      const first = created[0];
      toast(created.length === 1 ? "Connected. First sync started." : `Connected ${plural(created.length, "source")}. First syncs started.`, {
        action: first ? { label: "View", onPress: () => router.push(`/sources?open=${resourceId(first.name)}`) } : undefined,
      });
    } catch (error) {
      setBusy(false);
      toast(errorMessage(error), { tone: "danger" });
    }
  }

  function next() {
    if (busy || ask || waiting) return;
    if (step === 1) return app && goto(2);
    if (step === 2) {
      if (account === NEW_ACCOUNT) return app === CONFLUENCE ? void verifyConfluence() : void signIn();
      const a = connections.byName.get(account);
      return a?.state === "ACTIVE" && goto(3);
    }
    if (step === 3) {
      if (!picked.length) return setSelErr(isGoogle ? "Choose at least one folder." : "Choose at least one space or page.");
      return goto(4);
    }
    void submit();
  }

  /* ── Render ── */

  const stepper = (
    <ol className="src-stepper" aria-label="Steps">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "current" : "todo";
        return (
          <li key={label} className={`src-stepper__step src-stepper__step--${state}`} aria-current={n === step ? "step" : undefined}>
            <span className="src-stepper__dot">{n < step ? <Check className="i i-xs" aria-hidden /> : n}</span>
            <span className="src-stepper__label">{label}</span>
          </li>
        );
      })}
    </ol>
  );

  let body = null;
  if (step === 1) body = <AppStep connectors={connectors.data} isLoading={connectors.isPending} error={connectors.isError ? connectors.error : null} retry={() => void connectors.refetch()} value={app} requested={requests.requested} onPick={(v) => {
    if (v !== app) {
      setApp(v);
      setAccount("");
      setConfErrors({});
    }
    goto(2);
  }} onRequested={() => void requests.refetch()} />;
  else if (step === 2) {
    if (waiting === "new") body = <WaitingState title={`Finish signing in with ${provider}`} description={`A ${provider} window opened. Come back here when you’re done.`} />;
    else
      body = (
        <>
          <p className="muted mb-12">Which {appName(app)} account should BoMesh read from?</p>
          <div className="stack gap-8 src-choices">
            {signInError ? <Callout tone="danger" description={signInError} /> : null}
            <RadioGroup aria-label="Account" value={account} onChange={(v) => { setAccount(v); setSignInError(""); }} isDisabled={busy || !!waiting} className="stack gap-8">
              {accounts.map((a) => {
                const off = a.state !== "ACTIVE";
                const used = (sources.data ?? []).filter((s) => s.connection === a.name).length;
                return (
                  <Radio key={a.name} value={a.name ?? ""} isDisabled={off} className={clsx("choice", off && "src-choice--off")}>
                    <Radio.Content className="choice__content">
                      <Radio.Control>
                        <Radio.Indicator />
                      </Radio.Control>
                      <span className="grow src-min">
                        <span className="choice__title truncate" style={{ display: "block" }} translate="no">
                          {accountLabel(a)}
                        </span>
                        <span className="choice__desc" style={{ display: "block" }}>
                          {off ? "Access expired — reconnect to use it" : used ? `Used by ${plural(used, "source")}` : "Connected"}
                        </span>
                      </span>
                      {off ? (
                        waiting === a.name ? (
                          <span className="row gap-6 t-sm muted src-choice__trail">
                            <Spinner size="sm" />
                            Waiting for {provider}…
                          </span>
                        ) : (
                          <span className="src-choice__trail">
                            <Button size="sm" variant="secondary" isDisabled={busy || !!waiting} onPress={() => void signIn(a)}>
                              Reconnect
                            </Button>
                          </span>
                        )
                      ) : null}
                    </Radio.Content>
                  </Radio>
                );
              })}
              <Radio value={NEW_ACCOUNT} className="choice">
                <Radio.Content className="choice__content">
                  <Radio.Control>
                    <Radio.Indicator />
                  </Radio.Control>
                  <span className="grow">
                    <span className="choice__title" style={{ display: "block" }}>
                      Connect a new account
                    </span>
                    <span className="choice__desc" style={{ display: "block" }}>
                      {app === CONFLUENCE ? "Use your Confluence site and an API token." : `Sign in with ${provider}.`}
                    </span>
                  </span>
                </Radio.Content>
              </Radio>
            </RadioGroup>
            {account === NEW_ACCOUNT && app === CONFLUENCE ? (
              <div className="src-conf">
                <ConfluenceFields
                  value={conf}
                  errors={confErrors}
                  isDisabled={busy}
                  onSubmit={next}
                  onChange={(v, f) => {
                    setConf(v);
                    setConfErrors(revalidate(v, confErrors, f, hosts));
                  }}
                />
              </div>
            ) : null}
          </div>
        </>
      );
  } else if (step === 3) {
    body = (
      <ContentStep
        tree={tree}
        app={app}
        noun={noun}
        loading={loading}
        loadError={loadError}
        open={open}
        selection={selection}
        q={q}
        selErr={selErr}
        onQuery={setQ}
        onRetry={(node) => void loadLevel(node, node === ROOT ? "" : (tree.nodes[node]?.path ?? ""))}
        onToggleOpen={(node) => {
          const nextOpen = new Set(open);
          if (nextOpen.has(node)) nextOpen.delete(node);
          else {
            nextOpen.add(node);
            if (!tree.children[node] && !loading.has(node)) void loadLevel(node, tree.nodes[node]?.path ?? "");
          }
          setOpen(nextOpen);
        }}
        onCheck={(node) => {
          const nextSel = toggleSelection(tree, selection, node);
          setSelection(nextSel);
          if (nextSel.length) setSelErr("");
        }}
        onClear={() => setSelection([])}
      />
    );
  } else {
    const first = picked[0];
    const content = first ? `${pathOf(tree, first)}${picked.length > 1 ? ` +${picked.length - 1}` : ""}` : "—";
    const name = first ? sourceNameFor(tree, first, appKey(app), (sources.data ?? []).map(sourceName)) : "";
    const connection = connections.byName.get(account);
    body = (
      <div className="stack gap-16">
        <OptionSelect
          label="Knowledge base"
          value={kb}
          placeholder="Choose a knowledge base"
          isInvalid={!!errors.kb}
          options={[...bases.targets.map((b) => [b.name ?? "", b.displayName ?? ""] as const), [NEW_BASE, "New knowledge base…"] as const]}
          onChange={(v) => {
            setKb(v);
            setErrors((e) => ({ ...e, kb: undefined }));
          }}
        />
        {errors.kb ? (
          <div className="field-error" role="alert">
            <CircleAlert className="i" aria-hidden />
            <span>{errors.kb}</span>
          </div>
        ) : null}
        {kb === NEW_BASE ? (
          <TextField
            className="field"
            value={kbName}
            onChange={(v) => {
              setKbName(v);
              if (errors.kbName) setErrors((e) => ({ ...e, kbName: kbNameError(v) || undefined }));
            }}
            isRequired
            isInvalid={!!errors.kbName}
            autoFocus
            fullWidth
          >
            <Label>Name</Label>
            <Input placeholder="e.g. Marketing Assets" onKeyDown={(e) => e.key === "Enter" && next()} />
            <FieldError>{errors.kbName}</FieldError>
          </TextField>
        ) : null}
        <div className="field">
          <span className="label">Keep in sync</span>
          <ScheduleFields label="Keep in sync" draft={draft} onChange={setDraft} />
          {draft.freq === "manual" ? <p className="description">Syncs only when someone clicks Sync now.</p> : null}
        </div>
        <div className="field">
          <span className="label">New and changed files</span>
          <ChoiceGroup label="New and changed files" value={policy} options={POLICY_CHOICES} onChange={setPolicy} />
          <Description className="description">
            {policy === "REVIEW_FIRST" ? "The first sync sends the files it finds to the review queue." : "The files it finds will be ready to publish after the first sync."}
          </Description>
        </div>
        <Card variant="secondary">
          <KeyValue
            pairs={[
              ["Source", <span key="n" translate="no">{name}{picked.length > 1 ? ` +${picked.length - 1}` : ""}</span>],
              [
                "Account",
                <span key="a" className="row gap-8">
                  <AppIcon app={appKey(app)} size="sm" />
                  <span className="truncate" translate="no">
                    {accountLabel(connection) || "—"}
                  </span>
                </span>,
              ],
              ["Content", <span key="c" translate="no">{content}</span>],
            ]}
          />
        </Card>
      </div>
    );
  }

  let footer;
  if (ask)
    footer = (
      <>
        <span className="t-sm medium" style={{ marginRight: "auto" }}>
          Discard this source?
        </span>
        <Button variant="secondary" onPress={() => setAsk(false)}>
          Keep editing
        </Button>
        <Button variant="danger" autoFocus onPress={closeIngestionOverlay}>
          Discard
        </Button>
      </>
    );
  else if (waiting)
    footer = (
      <Button variant="secondary" onPress={() => pending.current?.cancel()}>
        Cancel
      </Button>
    );
  else {
    const back = (
      <Button variant="secondary" isDisabled={busy} onPress={() => goto(step - 1)}>
        Back
      </Button>
    );
    if (step === 1)
      footer = (
        <>
          <Button variant="secondary" onPress={close}>
            Cancel
          </Button>
          <Button key="next-1" variant="primary" isDisabled={!app} onPress={next}>
            Continue
          </Button>
        </>
      );
    else if (step === 2) {
      const a = connections.byName.get(account);
      footer = (
        <>
          {back}
          {account === NEW_ACCOUNT && app !== CONFLUENCE ? (
            <Button key="next-2-oauth" variant="primary" onPress={next}>
              Continue with {provider}
              <ExternalLink className="i" aria-hidden />
            </Button>
          ) : account === NEW_ACCOUNT ? (
            <Button key="next-2-verify" variant="primary" isPending={busy} onPress={next}>
              Verify and continue
            </Button>
          ) : (
            <Button key="next-2" variant="primary" isDisabled={a?.state !== "ACTIVE"} onPress={next}>
              Continue
            </Button>
          )}
        </>
      );
    } else if (step === 3)
      footer = (
        <>
          {back}
          <Button key="next-3" variant="primary" onPress={next}>
            Continue
          </Button>
        </>
      );
    else
      footer = (
        <>
          {back}
          <Button key="next-4" variant="primary" isPending={busy} onPress={next}>
            Connect and sync
          </Button>
        </>
      );
  }

  return (
    <Modal.Backdrop isOpen isDismissable={!waiting && !busy} isKeyboardDismissDisabled={!!waiting || busy} onOpenChange={(o) => !o && close()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          {waiting ? null : <Modal.CloseTrigger aria-label="Close" />}
          <Modal.Header>
            <Modal.Heading>Connect a source</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            {stepper}
            {body}
          </Modal.Body>
          <Modal.Footer>{footer}</Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/* ═══════════════ Step 1: App ═══════════════ */

function AppStep({
  connectors,
  isLoading,
  error,
  retry,
  value,
  requested,
  onPick,
  onRequested,
}: {
  connectors: readonly Connector[] | undefined;
  isLoading: boolean;
  error: unknown;
  retry: () => void;
  value: string;
  requested: ReadonlySet<string>;
  onPick: (connector: string) => void;
  onRequested: () => void;
}) {
  const { id } = useWorkspace();
  const [sending, setSending] = useState("");
  if (error) return <ErrorState error={error} onRetry={retry} />;
  if (isLoading) return <SkeletonRows rows={2} />;
  const apps = connectors ?? [];
  if (!apps.length) return <EmptyState icon={Search} title="No apps available" description="Ask your platform admin to turn on Google Drive or Confluence." compact />;

  const request = async (c: Connector) => {
    setSending(c.name ?? "");
    try {
      await requestConnector(id, c);
      toast(`Request for ${appName(c.name, apps)} sent to your platform admin`);
      onRequested();
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setSending("");
    }
  };

  return (
    <>
      <p className="muted mb-12">Where are the documents?</p>
      <div className="src-apps" role="radiogroup" aria-label="App">
        {apps.map((c) =>
          c.state === "ACTIVE" ? (
            <button key={c.name} type="button" className="card card--action src-app" role="radio" aria-checked={value === c.name} onClick={() => onPick(c.name ?? "")}>
              <AppIcon app={appKey(c.name)} size="lg" />
              <span className="src-app__name">{appName(c.name, apps)}</span>
              <span className="src-app__desc">{c.description}</span>
            </button>
          ) : (
            <div key={c.name} className="card src-app src-app--off" aria-disabled="true">
              <AppIcon app={appKey(c.name)} size="lg" />
              <span className="src-app__name">{appName(c.name, apps)}</span>
              <span className="src-app__desc">Not available yet</span>
              <span className="src-app__foot">
                {requested.has(c.name ?? "") ? (
                  <Chip size="sm">
                    <Check className="i i-xs" aria-hidden />
                    Requested
                  </Chip>
                ) : (
                  <button type="button" className="link-button" disabled={sending === c.name} aria-busy={sending === c.name} onClick={() => void request(c)}>
                    Request
                  </button>
                )}
              </span>
            </div>
          ),
        )}
      </div>
    </>
  );
}

/* ═══════════════ Step 3: Content ═══════════════ */

function ContentStep({
  tree,
  app,
  noun,
  loading,
  loadError,
  open,
  selection,
  q,
  selErr,
  onQuery,
  onRetry,
  onToggleOpen,
  onCheck,
  onClear,
}: {
  tree: ContentTree;
  app: string;
  noun: string;
  loading: ReadonlySet<string>;
  loadError: { node: string; error: unknown } | null;
  open: ReadonlySet<string>;
  selection: readonly string[];
  q: string;
  selErr: string;
  onQuery: (q: string) => void;
  onRetry: (node: string) => void;
  onToggleOpen: (node: string) => void;
  onCheck: (node: string) => void;
  onClear: () => void;
}) {
  const needle = q.trim().toLowerCase();
  const picked = selection.filter((s) => tree.nodes[s]);

  const rows = (parent: string, depth: number, force: boolean): React.ReactNode[] =>
    (tree.children[parent] ?? []).flatMap((nodeId) => {
      const node = tree.nodes[nodeId]!;
      const hit = !!needle && node.name.toLowerCase().includes(needle);
      if (needle && !force && !matches(tree, nodeId, needle)) return [];
      const kids = tree.children[nodeId];
      const isOpen = open.has(nodeId) || (!!needle && !!kids?.some((k) => matches(tree, k, needle)));
      const state = checkState(tree, selection, nodeId);
      const Icon = app === "connectors/google_drive" ? Folder : node.type === "page" ? FileText : BookOpen;
      const out: React.ReactNode[] = [
        <div key={nodeId} className="src-tree__row" style={{ "--depth": depth } as React.CSSProperties}>
          {node.hasChildren ? (
            <Button isIconOnly variant="ghost" size="sm" className="src-tree__tog button--muted" aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.name}`} onPress={() => onToggleOpen(nodeId)}>
              {loading.has(nodeId) ? <Spinner size="sm" /> : isOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            </Button>
          ) : (
            <span className="src-tree__tog" aria-hidden />
          )}
          <Checkbox isSelected={state === "all"} isIndeterminate={state === "some"} onChange={() => onCheck(nodeId)}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <span className="row gap-8 src-min checkbox__label">
                <Icon className="i i-sm muted" aria-hidden />
                <span className="truncate" translate="no">
                  {node.name}
                </span>
              </span>
            </Checkbox.Content>
          </Checkbox>
        </div>,
      ];
      if (isOpen && kids) out.push(...rows(nodeId, depth + 1, force || hit));
      if (isOpen && loadError?.node === nodeId)
        out.push(
          <div key={`${nodeId}-err`} className="src-tree__row t-sm text-danger" style={{ "--depth": depth + 1 } as React.CSSProperties}>
            {errorMessage(loadError.error)}
            <Button variant="ghost" size="sm" onPress={() => onRetry(nodeId)}>
              Try again
            </Button>
          </div>,
        );
      return out;
    });

  let content: React.ReactNode;
  // The provider's own reason ("The site could not list its resources.") beats the generic copy, even on 503.
  if (loadError?.node === ROOT)
    content = (
      <ErrorState
        error={loadError.error}
        description={loadError.error instanceof ApiError ? loadError.error.message : undefined}
        onRetry={() => onRetry(ROOT)}
        boxed={false}
      />
    );
  else if (!tree.children[ROOT]) content = <SkeletonRows rows={4} />;
  else {
    const list = rows(ROOT, 0, false);
    content = list.length ? list : <EmptyState icon={Search} title={needle ? "No matches" : `No ${noun} found`} description={needle ? "Try a different name." : "This account can’t reach anything to sync."} compact />;
  }

  return (
    <>
      <p className="muted mb-12">Choose the {noun} to keep in sync. New files inside them sync automatically.</p>
      <div className="toolbar src-tree-bar">
        <SearchInput value={q} onChange={onQuery} placeholder={`Search ${noun}`} />
        <div className="toolbar__end">
          <span className="t-sm muted" aria-live="polite">
            {picked.length ? plural(picked.length, "item") : "Nothing selected"}
          </span>
          {picked.length ? (
            <Button variant="ghost" size="sm" onPress={onClear}>
              Clear
            </Button>
          ) : null}
        </div>
      </div>
      <div className="src-tree" role="group" aria-label="Content to sync">
        {content}
      </div>
      {selErr ? (
        <div className="field-error mt-8" role="alert">
          <CircleAlert className="i" aria-hidden />
          <span>{selErr}</span>
        </div>
      ) : null}
    </>
  );
}
