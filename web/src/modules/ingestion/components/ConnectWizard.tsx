"use client";

import { Check, ExternalLink, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog } from "@/components/ui/Dialog";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Radio } from "@/components/ui/Radio";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { invalidateApiData } from "@/lib/api/revision";
import { hasSessionPermission } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import {
  AuthorizationCancelled,
  beginAuthorization,
  PopupBlocked,
  type PendingAuthorization,
} from "@/modules/ingestion/authorize";
import { confluenceErrors, confluenceSite, knowledgeBaseNameError, type ConfluenceErrors, type ConfluenceField } from "@/modules/ingestion/connect-form";
import { connectionState, sourceName } from "@/modules/ingestion/connection-state";
import { knowledgeConnectors } from "@/modules/ingestion/connectors";
import { EMPTY_TREE, pathOf, sourceNameFor, type ContentTree } from "@/modules/ingestion/content-tree";
import { connectionsApi, type Connection, type Source } from "@/modules/ingestion/integrations-api";
import { ingestionActions, useRequestedConnectors, type ConnectorEntry } from "@/modules/ingestion/queries";
import {
  browserTimezone,
  DEFAULT_SYNC_TIME,
  describeDraft,
  timezoneCity,
  validateDraft,
  type ScheduleDraft,
  type ScheduleErrors,
} from "@/modules/ingestion/schedule";
import { errorMessage, pluralize } from "@/lib/format";

import { AppIcon } from "./AppIcon";
import { ContentPicker, contentNoun } from "./ContentPicker";
import { providerOf, ProviderButton } from "./ProviderButton";
import { reconnectedMessage, usesCredentials } from "./ReconnectDialog";
import { ScheduleFields } from "./ScheduleFields";
import { SignInWaiting } from "./SignInWaiting";
import type { SourcesModel } from "./SourcesScreen";

const STEPS = ["Choose app", "Account", "Content", "Destination"] as const;
type Step = 1 | 2 | 3 | 4;

/** `new-oauth`: sign in with the provider; `new-credentials`: a site and an API token. */
type AccountChoice = string | "new-oauth" | "new-credentials" | "";

const NEW_KNOWLEDGE_BASE = "__new";
const TOKEN_HELP_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

interface AppOption {
  key: string;
  name: string;
  description: string;
  entry?: ConnectorEntry;
  available: boolean;
}

/**
 * Connecting a source, in the four decisions it is: which app, which account,
 * what content, and where it goes and how often. Closing after the first step
 * asks before discarding; Escape while a sign-in window is open stops waiting.
 * Creating the sources starts their first syncs.
 */
export function ConnectWizard({
  model,
  initialCollectionId,
  onClose,
  onConnected,
}: {
  model: SourcesModel;
  initialCollectionId: string | null;
  onClose: () => void;
  onConnected: (created: Source[]) => void;
}) {
  const toast = useToast();
  const { session } = useCurrentWorkspace();
  const requested = useRequestedConnectors(true);
  const [step, setStep] = useState<Step>(1);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const [app, setApp] = useState<string | null>(null);
  const [requesting, setRequesting] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountChoice>("");
  const [accountError, setAccountError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<{ connectionId: string | null } | null>(null);
  const pending = useRef<PendingAuthorization | null>(null);
  const [confluence, setConfluence] = useState({ site: "", email: "", token: "" });
  const [confluenceFieldErrors, setConfluenceFieldErrors] = useState<ConfluenceErrors>({});

  const [tree, setTree] = useState<ContentTree>(EMPTY_TREE);
  const [selection, setSelection] = useState<string[]>([]);
  const [contentError, setContentError] = useState("");

  const [kb, setKb] = useState("");
  const [kbName, setKbName] = useState("");
  const [kbErrors, setKbErrors] = useState<{ kb?: string; name?: string }>({});
  const [createdKb, setCreatedKb] = useState<{ id: string; title: string } | null>(null);
  const [schedule, setSchedule] = useState<ScheduleDraft>(() => ({
    frequency: "daily",
    day: "mon",
    time: DEFAULT_SYNC_TIME,
    timezone: browserTimezone(),
  }));
  const [scheduleErrors, setScheduleErrors] = useState<ScheduleErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => () => pending.current?.cancel(), []);

  const apps: AppOption[] = useMemo(() => {
    const listed = model.catalogue.map((entry) => ({
      key: entry.connector.key,
      name: entry.connector.name,
      description: entry.connector.description,
      entry,
      available: entry.capability?.available ?? false,
    }));
    const missing = knowledgeConnectors
      .filter((connector) => !listed.some((item) => item.key === connector.key))
      .map((connector) => ({ key: connector.key, name: connector.name, description: connector.description, available: false }));
    return [...listed.filter((item) => item.available), ...listed.filter((item) => !item.available), ...missing];
  }, [model.catalogue]);

  const option = apps.find((item) => item.key === app);
  const capability = option?.entry?.capability;
  const provider = app ? providerOf(app, option?.entry) : { key: "", name: "" };
  const connections = useMemo(
    () => (model.data?.connections ?? []).filter((connection) => connection.connector_key === app),
    [app, model.data],
  );
  const canSignIn = Boolean(capability?.authorization_available);
  const canUseToken = app === "confluence" && (capability?.accepts_credentials ?? true);
  const chosenConnection = connections.find((connection) => connection.id === account);

  const knowledgeBases = useMemo(() => {
    const options = (model.data?.knowledgeBases ?? []).filter((item) => item.canAddSources);
    if (createdKb && !options.some((item) => item.id === createdKb.id)) {
      options.push({ ...createdKb, canAddSources: true, documentCount: 0 });
    }
    return options.sort((left, right) => left.title.localeCompare(right.title));
  }, [createdKb, model.data]);
  const canCreateKb = hasSessionPermission(session, "knowledge.manage");

  // Preselect the destination a knowledge base asked for, once its list arrives.
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !initialCollectionId || !model.data) return;
    preselected.current = true;
    if (knowledgeBases.some((item) => item.id === initialCollectionId)) setKb(initialCollectionId);
  }, [initialCollectionId, knowledgeBases, model.data]);

  const goTo = (next: Step) => {
    setStep(next);
    setAsking(false);
    setContentError("");
  };

  const chooseApp = (key: string) => {
    if (key !== app) {
      const entry = apps.find((item) => item.key === key)?.entry;
      const ownConnections = (model.data?.connections ?? []).filter((connection) => connection.connector_key === key);
      const ready = ownConnections.find((connection) => connection.status === "connected");
      setApp(key);
      setAccount(
        ready?.id ??
          (ownConnections.length
            ? ""
            : entry?.capability?.authorization_available
              ? "new-oauth"
              : "new-credentials"),
      );
      setAccountError(null);
      setConfluenceFieldErrors({});
      setTree(EMPTY_TREE);
      setSelection([]);
    }
    goTo(2);
  };

  const request = async (item: AppOption) => {
    setRequesting(item.key);
    try {
      await ingestionActions.requestConnector(item.key);
      toast.show({ message: `Requested ${item.name}` });
    } catch (cause) {
      toast.show({ tone: "err", message: errorMessage(cause, "The request") });
    } finally {
      setRequesting(null);
    }
  };

  const selectAccount = (connectionId: string) => {
    if (connectionId !== account) {
      setTree(EMPTY_TREE);
      setSelection([]);
    }
    setAccount(connectionId);
  };

  const cancelWaiting = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
    setWaiting(null);
  }, []);

  /** A provider window for a new account, or to renew an expired one in the list. */
  const signIn = (renew: Connection | null) => {
    if (!app) return;
    setAccountError(null);
    let authorization: PendingAuthorization;
    try {
      authorization = beginAuthorization({ connectorKey: app, ownerType: "tenant", connectionId: renew?.id });
    } catch (cause) {
      setAccountError(cause instanceof PopupBlocked ? cause.message : "The sign-in window could not be opened.");
      return;
    }
    pending.current = authorization;
    setWaiting({ connectionId: renew?.id ?? null });
    authorization.completed.then(
      async (result) => {
        pending.current = null;
        setWaiting(null);
        if (renew) {
          const started = await ingestionActions.resumeAfterReconnect(renew.id, model.data?.sources ?? []);
          toast.show({ message: reconnectedMessage(model.connectorName(renew.connector_key), started) });
          selectAccount(renew.id);
          return;
        }
        invalidateApiData();
        toast.show({ message: `${provider.name} account connected` });
        selectAccount(result.connectionId);
        goTo(3);
      },
      (cause: unknown) => {
        pending.current = null;
        setWaiting(null);
        if (!(cause instanceof AuthorizationCancelled)) {
          setAccountError(`${provider.name} didn’t confirm the sign-in. Try again, or use a different account.`);
        }
      },
    );
  };

  const connectedHosts = connections
    .map((connection) => connection.account.resource_label || connection.account.label || "")
    .filter(Boolean);

  const verifyConfluence = async () => {
    const errors = confluenceErrors(confluence, connectedHosts);
    setConfluenceFieldErrors(errors);
    const first = (["site", "email", "token"] as const).find((field) => errors[field]);
    if (first) {
      document.getElementById(`wizard-confluence-${first}`)?.focus();
      return;
    }
    const site = confluenceSite(confluence.site)!;
    setBusy(true);
    setAccountError(null);
    let created: Connection | null = null;
    try {
      created = await connectionsApi.createWithCredentials({
        connector_key: "confluence",
        display_name: site.host,
        config: { wiki_base: site.wikiBase, is_cloud: site.cloud },
        credentials: { confluence_username: confluence.email.trim(), confluence_access_token: confluence.token.trim() },
        owner_type: "workspace",
      });
      // Connecting includes proving the token works: a bad one fails here,
      // beside the field, not on tonight's first sync.
      const result = await connectionsApi.validate(created.id);
      if (!result.valid) throw new Error("rejected");
      invalidateApiData();
      toast.show({ message: `Connected ${site.host}` });
      selectAccount(created.id);
      goTo(3);
    } catch (cause) {
      if (created) {
        // A connection whose token was refused is not kept half-made.
        await connectionsApi.remove(created.id).catch(() => undefined);
        setConfluenceFieldErrors({ token: "Confluence rejected this token. Check it and try again." });
        document.getElementById("wizard-confluence-token")?.focus();
      } else {
        setAccountError(errorMessage(cause, "Connecting"));
      }
    } finally {
      setBusy(false);
    }
  };

  const takenNames = useMemo(() => (model.data?.sources ?? []).map(sourceName), [model.data]);
  const plannedNames = useMemo(() => {
    const taken = [...takenNames];
    return selection.map((id) => {
      const name = sourceNameFor(tree, id, app ?? "", taken);
      taken.push(name);
      return name;
    });
  }, [app, selection, takenNames, tree]);

  const submit = async () => {
    if (!chosenConnection && !account) return;
    const errors: { kb?: string; name?: string } = {};
    if (!kb) errors.kb = "Choose where documents go.";
    if (kb === NEW_KNOWLEDGE_BASE) {
      const problem = knowledgeBaseNameError(kbName, (model.data?.knowledgeBases ?? []).map((item) => item.title));
      if (problem) errors.name = problem;
    }
    const foundScheduleErrors = validateDraft(schedule);
    setKbErrors(errors);
    setScheduleErrors(foundScheduleErrors);
    if (errors.kb || errors.name) {
      document.getElementById(errors.kb ? "wizard-kb" : "wizard-kb-name")?.focus();
      return;
    }
    if (foundScheduleErrors.day || foundScheduleErrors.time) return;

    setBusy(true);
    setSubmitError(null);
    try {
      let collectionId = kb;
      if (kb === NEW_KNOWLEDGE_BASE) {
        const created = await ingestionActions.createKnowledgeBase(kbName);
        setCreatedKb({ id: created.id, title: created.title });
        setKb(created.id);
        collectionId = created.id;
      }
      const bodies = selection.map((id, index) => ({
        collection_id: collectionId,
        display_name: plannedNames[index],
        resource_type: tree.nodes[id]?.resourceType ?? "",
        external_resource_id: id,
      }));
      const { created, failed } = await ingestionActions.createSources(account, bodies, schedule);
      if (!failed) {
        onConnected(created);
        return;
      }
      // Keep only what still has to be created, so trying again never duplicates.
      setSelection((current) => current.slice(created.length));
      setSubmitError(
        `${created.length ? `Connected ${pluralize(created.length, "source")}. ` : ""}${failed.body.display_name} couldn’t be added: ${errorMessage(failed.error, "The source")}`,
      );
    } catch (cause) {
      setSubmitError(errorMessage(cause, "Connecting"));
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (busy || asking) return;
    if (step === 2) {
      if (account === "new-oauth") signIn(null);
      else if (account === "new-credentials") void verifyConfluence();
      else if (chosenConnection?.status === "connected") goTo(3);
      return;
    }
    if (step === 3) {
      if (!selection.length) {
        setContentError(app === "google_drive" ? "Choose at least one folder." : app === "confluence" ? "Choose at least one space or page." : "Choose at least one item.");
        return;
      }
      goTo(4);
      return;
    }
    if (step === 4) void submit();
  };

  const close = () => {
    if (waiting) {
      cancelWaiting();
      return;
    }
    if (busy) return;
    if (asking) {
      setAsking(false);
      return;
    }
    if (step > 1) {
      setAsking(true);
      return;
    }
    onClose();
  };

  const back = (
    <Button disabled={busy} onClick={() => goTo((step - 1) as Step)} variant="secondary">
      Back
    </Button>
  );

  let footer: React.ReactNode;
  if (asking) {
    footer = (
      <>
        <span className="mr-auto font-medium">Discard this connection?</span>
        <Button onClick={() => setAsking(false)} variant="secondary">
          Keep editing
        </Button>
        <Button data-autofocus onClick={onClose} variant="danger">
          Discard
        </Button>
      </>
    );
  } else if (waiting) {
    footer = (
      <Button onClick={cancelWaiting} variant="secondary">
        Cancel
      </Button>
    );
  } else if (step === 1) {
    footer = (
      <Button onClick={onClose} variant="secondary">
        Cancel
      </Button>
    );
  } else if (step === 2) {
    footer = (
      <>
        {back}
        {account === "new-oauth" && app ? (
          <ProviderButton connectorKey={app} onClick={next} provider={provider} />
        ) : account === "new-credentials" ? (
          <Button loading={busy} onClick={next}>
            Verify and continue
          </Button>
        ) : (
          <Button disabled={chosenConnection?.status !== "connected"} onClick={next}>
            Continue
          </Button>
        )}
      </>
    );
  } else if (step === 3) {
    footer = (
      <>
        {back}
        <Button onClick={next}>Continue</Button>
      </>
    );
  } else {
    footer = (
      <>
        {back}
        <Button loading={busy} onClick={next}>
          Connect and sync
        </Button>
      </>
    );
  }

  return (
    <Dialog
      bodyClassName="pt-3"
      busy={busy}
      description={<Stepper step={step} />}
      footer={footer}
      onClose={close}
      open
      size="lg"
      title="Connect a source"
    >
      {step === 1 && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3.5">
          <p className="text-text-secondary">Where are the documents you want to bring in?</p>
          {model.catalogue.length === 0 && !model.data ? (
            <p className="text-text-tertiary">Loading apps…</p>
          ) : (
            <div className="grid grid-cols-3 gap-3 max-[720px]:grid-cols-2">
              {apps.map((item) =>
                item.available ? (
                  <button
                    className={cn(
                      "flex min-h-[136px] flex-col items-start gap-2.5 rounded-lg border border-border-subtle bg-surface-base p-4 text-left",
                      "transition-colors duration-(--duration-fast) hover:border-border-strong focus-visible:shadow-(--shadow-focus) focus-visible:outline-none",
                      app === item.key && "border-accent-primary shadow-[0_0_0_1px_var(--accent-primary)]",
                    )}
                    key={item.key}
                    onClick={() => chooseApp(item.key)}
                    type="button"
                  >
                    <AppIcon connector={item.key} size="lg" />
                    <span className="font-semibold">{item.name}</span>
                    <span className="-mt-1.5 text-meta text-text-tertiary">{item.description}</span>
                  </button>
                ) : (
                  <div
                    className="flex min-h-[136px] flex-col items-start gap-2.5 rounded-lg border border-border-subtle bg-surface-subtle p-4"
                    key={item.key}
                  >
                    <AppIcon className="opacity-55" connector={item.key} size="lg" />
                    <span className="font-semibold text-text-secondary">{item.name}</span>
                    <span className="mt-auto flex w-full items-center justify-between gap-2 text-meta text-text-tertiary">
                      Not available yet
                      {requested.data?.has(item.key.toLowerCase()) ? (
                        <span>Requested</span>
                      ) : (
                        <Button
                          aria-label={`Request ${item.name}`}
                          loading={requesting === item.key}
                          onClick={() => void request(item)}
                          size="sm"
                          variant="link"
                        >
                          Request
                        </Button>
                      )}
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      )}

      {step === 2 && app && (
        waiting && !waiting.connectionId ? (
          <SignInWaiting
            description={`A ${provider.name} sign-in window opened. Come back here when you’re done.`}
            onFocus={() => pending.current?.focus()}
            provider={provider.name}
          />
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
            <p className="mb-1.5 text-text-secondary">Which {option?.name ?? "app"} account should BoMesh read from?</p>
            {accountError && <Callout tone="err">{accountError}</Callout>}
            {connections.map((connection) => (
              <AccountRow
                busy={busy || Boolean(waiting)}
                checked={account === connection.id}
                connection={connection}
                key={connection.id}
                onReconnect={() =>
                  usesCredentials(connection, model) ? model.open.reconnect(connection.id) : signIn(connection)
                }
                onSelect={() => {
                  setAccountError(null);
                  selectAccount(connection.id);
                }}
                providerName={provider.name}
                usedBy={(model.data?.sources ?? []).filter((source) => source.connection_id === connection.id).length}
                waiting={waiting?.connectionId === connection.id}
              />
            ))}
            {canSignIn && (
              <NewAccountRow
                checked={account === "new-oauth"}
                description={`Sign in with ${provider.name}.`}
                disabled={busy || Boolean(waiting)}
                onSelect={() => setAccount("new-oauth")}
                title={canUseToken ? `Sign in with ${provider.name}` : "Connect a new account"}
                value="new-oauth"
              />
            )}
            {canUseToken && (
              <NewAccountRow
                checked={account === "new-credentials"}
                description="Use your Confluence site and an API token."
                disabled={busy || Boolean(waiting)}
                onSelect={() => {
                  setAccount("new-credentials");
                  requestAnimationFrame(() => document.getElementById("wizard-confluence-site")?.focus());
                }}
                title={canSignIn ? "Use a site URL and API token" : "Connect a new account"}
                value="new-credentials"
              />
            )}
            {account === "new-credentials" && (
              <ConfluenceForm
                connectedHosts={connectedHosts}
                disabled={busy}
                errors={confluenceFieldErrors}
                onChange={setConfluence}
                onErrorsChange={setConfluenceFieldErrors}
                onSubmit={next}
                values={confluence}
              />
            )}
          </div>
        )
      )}

      {step === 3 && app && account && (
        <ContentPicker
          connectionId={account}
          connectorKey={app}
          error={contentError}
          onSelectionChange={(value) => {
            setSelection(value);
            if (value.length) setContentError("");
          }}
          onTreeChange={setTree}
          selection={selection}
          tree={tree}
        />
      )}

      {step === 4 && app && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <FormField error={kbErrors.kb} htmlFor="wizard-kb" label="Knowledge base" required>
            <Select
              onChange={(event) => {
                setKb(event.target.value);
                setKbErrors({});
                if (event.target.value === NEW_KNOWLEDGE_BASE) {
                  requestAnimationFrame(() => document.getElementById("wizard-kb-name")?.focus());
                }
              }}
              placeholder="Choose a knowledge base"
              value={kb}
            >
              {knowledgeBases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
              {canCreateKb && <option value={NEW_KNOWLEDGE_BASE}>Create new knowledge base…</option>}
            </Select>
          </FormField>
          {kb === NEW_KNOWLEDGE_BASE && (
            <FormField error={kbErrors.name} htmlFor="wizard-kb-name" label="New knowledge base name" required>
              <Input
                onBlur={() => {
                  if (!kbName) return;
                  const problem = knowledgeBaseNameError(kbName, (model.data?.knowledgeBases ?? []).map((item) => item.title));
                  setKbErrors((current) => ({ ...current, name: problem || undefined }));
                }}
                onChange={(event) => {
                  setKbName(event.target.value);
                  if (kbErrors.name) setKbErrors((current) => ({ ...current, name: undefined }));
                }}
                placeholder="e.g. Marketing Assets"
                value={kbName}
              />
            </FormField>
          )}
          <ScheduleFields
            draft={schedule}
            errors={scheduleErrors}
            idBase="wizard-schedule"
            label="Keep in sync"
            onChange={(value) => {
              setSchedule(value);
              setScheduleErrors({});
            }}
          />
          {submitError && <Callout tone="err">{submitError}</Callout>}
          <section className="rounded-lg bg-surface-subtle px-4 py-3.5" aria-labelledby="wizard-review">
            <h3 className="mb-2.5 text-section font-semibold" id="wizard-review">
              Review
            </h3>
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2">
              <dt className="text-text-tertiary">{plannedNames.length > 1 ? "Sources" : "Name"}</dt>
              <dd>{plannedNames.join(", ") || "—"}</dd>
              <dt className="text-text-tertiary">App</dt>
              <dd className="flex items-center gap-2">
                <AppIcon connector={app} size="xs" />
                {option?.name}
              </dd>
              <dt className="text-text-tertiary">Account</dt>
              <dd>{chosenConnection ? chosenConnection.account.label || chosenConnection.display_name : "—"}</dd>
              <dt className="text-text-tertiary">Content</dt>
              <dd>
                {selection.length
                  ? `${pathOf(tree, selection[0])}${selection.length > 1 ? ` +${selection.length - 1}` : ""}`
                  : "—"}
              </dd>
              <dt className="text-text-tertiary">Destination</dt>
              <dd>
                {kb === NEW_KNOWLEDGE_BASE
                  ? kbName.trim()
                    ? `${kbName.trim()} (new)`
                    : "New knowledge base"
                  : knowledgeBases.find((item) => item.id === kb)?.title ?? "—"}
              </dd>
              <dt className="text-text-tertiary">Schedule</dt>
              <dd>
                {describeDraft(schedule)}
                {schedule.frequency !== "manual" && ` (${timezoneCity(schedule.timezone)} time)`}
              </dd>
            </dl>
          </section>
          <p className="text-meta text-text-tertiary">
            The first sync starts as soon as you connect. New {contentNoun(app)} inside what you chose sync too.
          </p>
        </div>
      )}
    </Dialog>
  );
}

function Stepper({ step }: { step: Step }) {
  return (
    <ol aria-label="Progress" className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
      {STEPS.map((label, index) => {
        const number = (index + 1) as Step;
        const state = number < step ? "done" : number === step ? "current" : "next";
        return (
          <li aria-current={state === "current" ? "step" : undefined} className="flex items-center gap-2" key={label}>
            {index > 0 && <span aria-hidden="true" className="h-px w-5 bg-border-default" />}
            <span
              className={cn(
                "grid size-5 place-items-center rounded-full text-caption font-semibold",
                state === "done" && "bg-accent-soft text-text-accent",
                state === "current" && "bg-accent-primary text-text-on-accent",
                state === "next" && "bg-surface-inset text-text-tertiary",
              )}
            >
              {state === "done" ? <Check aria-hidden="true" className="size-3" /> : number}
            </span>
            <span className={cn("text-meta", state === "current" ? "font-medium text-text-primary" : "text-text-tertiary")}>
              {label}
              {state === "done" && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function AccountRow({
  connection,
  checked,
  busy,
  usedBy,
  waiting,
  providerName,
  onSelect,
  onReconnect,
}: {
  connection: Connection;
  checked: boolean;
  busy: boolean;
  usedBy: number;
  waiting: boolean;
  providerName: string;
  onSelect: () => void;
  onReconnect: () => void;
}) {
  const expired = connection.status !== "connected";
  const id = `wizard-account-${connection.id}`;
  const label = connection.account.label || connection.display_name;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border-default px-3.5 py-3",
        checked && !expired && "border-accent-primary bg-accent-soft shadow-[0_0_0_1px_var(--accent-primary)]",
        expired && "bg-surface-subtle",
      )}
    >
      <Radio checked={checked} disabled={expired || busy} id={id} name="wizard-account" onChange={onSelect} />
      <label className={cn("min-w-0 flex-1", expired ? "cursor-default" : "cursor-pointer")} htmlFor={id}>
        <span className="block truncate font-medium">{label}</span>
        <span className="block text-meta text-text-secondary">
          {expired
            ? connectionState(connection).value === "expired"
              ? "Access expired — reconnect to use it"
              : "Can’t be used right now — reconnect to use it"
            : usedBy
              ? `Used by ${pluralize(usedBy, "source")}`
              : "Connected"}
        </span>
      </label>
      {expired &&
        (waiting ? (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-meta text-text-tertiary" role="status">
            <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
            Waiting for {providerName}…
          </span>
        ) : (
          <Button disabled={busy} onClick={onReconnect} size="sm" variant="secondary">
            Reconnect
          </Button>
        ))}
    </div>
  );
}

function NewAccountRow({
  value,
  title,
  description,
  checked,
  disabled,
  onSelect,
}: {
  value: string;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const id = `wizard-account-${value}`;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border-default px-3.5 py-3",
        checked && "border-accent-primary bg-accent-soft shadow-[0_0_0_1px_var(--accent-primary)]",
      )}
    >
      <Radio checked={checked} disabled={disabled} id={id} name="wizard-account" onChange={onSelect} />
      <label className="min-w-0 flex-1 cursor-pointer" htmlFor={id}>
        <span className="block font-medium">{title}</span>
        <span className="block text-meta text-text-secondary">{description}</span>
      </label>
    </div>
  );
}

function ConfluenceForm({
  values,
  onChange,
  errors,
  onErrorsChange,
  connectedHosts,
  disabled,
  onSubmit,
}: {
  values: { site: string; email: string; token: string };
  onChange: (values: { site: string; email: string; token: string }) => void;
  errors: ConfluenceErrors;
  onErrorsChange: (errors: ConfluenceErrors) => void;
  connectedHosts: readonly string[];
  disabled: boolean;
  onSubmit: () => void;
}) {
  const fieldError = (field: ConfluenceField, next = values) => confluenceErrors(next, connectedHosts)[field];
  const bind = (field: ConfluenceField) => ({
    disabled,
    value: values[field],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = { ...values, [field]: event.target.value };
      onChange(next);
      // Once a field has been told it is wrong, it says when it is right.
      if (errors[field]) onErrorsChange({ ...errors, [field]: fieldError(field, next) });
    },
    onBlur: () => {
      if (values[field]) onErrorsChange({ ...errors, [field]: fieldError(field) });
    },
  });

  return (
    <div className="mt-1 grid gap-3 px-0.5 pt-1">
      <FormField
        error={errors.site}
        help="Your Confluence address, like northwind.atlassian.net."
        htmlFor="wizard-confluence-site"
        label="Site URL"
        required
      >
        <Input {...bind("site")} autoComplete="url" placeholder="yourcompany.atlassian.net" prefix="https://" spellCheck={false} />
      </FormField>
      <FormField error={errors.email} htmlFor="wizard-confluence-email" label="Email" required>
        <Input {...bind("email")} autoComplete="username" placeholder="you@company.com" type="email" />
      </FormField>
      <FormField
        error={errors.token}
        help={
          <a
            className="inline-flex items-center gap-1 rounded-xs text-text-accent hover:underline focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
            href={TOKEN_HELP_URL}
            rel="noreferrer"
            target="_blank"
          >
            How to create a token
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        }
        htmlFor="wizard-confluence-token"
        label="API token"
        required
      >
        <Input
          {...bind("token")}
          autoComplete="new-password"
          onKeyDown={(event) => {
            if (event.key === "Enter") onSubmit();
          }}
          placeholder="Paste your token"
          type="password"
        />
      </FormField>
    </div>
  );
}
