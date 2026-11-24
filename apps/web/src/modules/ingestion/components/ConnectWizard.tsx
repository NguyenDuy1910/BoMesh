"use client";

import { Button, Checkbox, Description, Dropdown, FieldError, Header, Input, Label, Modal, Radio, RadioGroup, Spinner, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, Check, ChevronDown, ChevronRight, CircleAlert, Clock, ExternalLink, FileText, Folder, Plug, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";

import { AppIcon, Callout, ChoiceGroup, Disclosure, EmptyState, ErrorState, LinkButton, SearchInput, SkeletonRows, Tip, toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { serverText } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { createBase, getItemIamPolicy, setItemIamPolicy } from "@/modules/knowledge/bases/api";
import { accessInfo, withGeneralAccess } from "@/modules/knowledge/bases/model";
import { knowledgeKeys } from "@/modules/knowledge/queries";

import { connectConfluence, isCancelled, signInAgain, signInNew, TokenRejected } from "../accounts";
import { browseResources, createSource, requestConnector, type Connection, type Connector, type PublishingPolicy, type Source } from "../api";
import { addChildren, checkState, claimOf, EMPTY_TREE, matches, pathOf, ROOT, sourceNameFor, toggleSelection, type ContentNode, type ContentTree } from "../content-tree";
import { confluenceErrors, connectedConfluenceHosts, EMPTY_CONFLUENCE, type ConfluenceErrors } from "../connect-form";
import { accountLabel, appKey, appName, POLICY_CHOICES, providerOf, sourceHref, sourceName } from "../model";
import { closeIngestionOverlay, type WizardOptions } from "../overlays";
import { useConnections, useConnectors, useInvalidateIngestion, useMyConnectorRequests, useSources } from "../queries";
import { DEFAULT_DRAFT, draftText, scheduleFor, tzShort, type ScheduleDraft } from "../schedule";
import { CONFLUENCE, ConfluenceFields, focusInvalid, revalidate, usePendingSignIn, WaitingState } from "./AccountDialogs";
import { OptionSelect, ScheduleFields } from "./ScheduleFields";
import { useCollectionIndex } from "./shared";

const STEPS = ["Ứng dụng", "Tài khoản", "Nội dung", "Đích đến"] as const;
const NEW_ACCOUNT = "new";
const NEW_COLLECTION = "__new";
const GOOGLE_DRIVE = "connectors/google_drive";

/** Words of four letters or more, for matching a picked folder to a collection's name. */
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 4);

/**
 * Add source (preview `M['src-wizard']`): App → Account (skipped when the app has exactly one connected
 * account) → Content (tri-state tree from `:browseResources`; folders another source already syncs are
 * disabled) → Destination with publishing policy and schedule. Each picked folder/space becomes one Source
 * (the API syncs one external resource per source, into a target collection fixed at creation); creating it
 * starts the first sync. Opened from a connected account it starts at Content with that account.
 */
export function ConnectWizard({ options }: { options: WizardOptions }) {
  const { id, workspace } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const refresh = useInvalidateIngestion();
  const connectors = useConnectors();
  const connections = useConnections();
  const sources = useSources();
  const collections = useCollectionIndex();
  const requests = useMyConnectorRequests();

  const startConnector = options.connector ?? (options.connection ? connections.byName.get(options.connection)?.connector : undefined) ?? "";
  const [step, setStep] = useState(options.connection ? 3 : options.connector ? 2 : 1);
  const [app, setApp] = useState(startConnector);
  const [account, setAccount] = useState(options.connection ?? "");
  const [skipAccount, setSkipAccount] = useState(false);
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

  const [collection, setCollection] = useState(options.collection ?? "");
  const [suggested, setSuggested] = useState("");
  const [newName, setNewName] = useState("");
  const [errors, setErrors] = useState<{ collection?: string; newName?: string }>({});
  const [draft, setDraft] = useState<ScheduleDraft>(DEFAULT_DRAFT);
  const [policy, setPolicy] = useState<PublishingPolicy>("REVIEW_FIRST");

  // Opened from an account before connections loaded: take the app from the account.
  useEffect(() => {
    if (!app && startConnector) setApp(startConnector);
  }, [app, startConnector]);

  const accounts = (connections.data ?? []).filter((c) => c.connector === app && c.state !== "AUTHORIZING");
  const hosts = connectedConfluenceHosts(connections.data ?? []);
  const provider = providerOf(app);
  const noun = app === GOOGLE_DRIVE ? "thư mục" : "cộng đồng và trang";

  // Preselect a usable account on the Account step.
  useEffect(() => {
    if (!app || step !== 2 || account) return;
    const ok = accounts.find((c) => c.state === "ACTIVE");
    setAccount(ok?.name ?? (accounts.length ? "" : NEW_ACCOUNT));
  }, [app, step, account, accounts]);

  // Only a collection the caller may sync into stays preselected.
  useEffect(() => {
    if (collection && collection !== NEW_COLLECTION && collections.data && !collections.targets.some((b) => b.name === collection)) setCollection("");
  }, [collection, collections.data, collections.targets]);

  /** What other sources of this app already sync, by provider resource ID: those folders can't be picked again. */
  const claims = useMemo(() => {
    const out = new Map<string, Source>();
    for (const s of sources.data ?? []) {
      const rid = s.externalResource?.resourceId;
      if (rid && connections.byName.get(s.connection)?.connector === app) out.set(rid, s);
    }
    return out;
  }, [sources.data, connections.byName, app]);
  const blocked = (nodeId: string) => claims.has(nodeId);

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

  const picked = useMemo(() => selection.filter((s) => tree.nodes[s]), [selection, tree]);

  /** Smart default for the destination (preview `suggestKb`): the only collection the caller can sync into, or the one sharing a word with what was picked. */
  function suggest(): string {
    const targets = collections.targets;
    if (targets.length === 1) return targets[0]!.name ?? "";
    const picks = new Set(picked.flatMap((n) => words(pathOf(tree, n))));
    const hits = targets.filter((b) => words(b.displayName ?? "").some((w) => picks.has(w)));
    return hits.length === 1 ? (hits[0]!.name ?? "") : "";
  }

  const goto = (n: number) => {
    if (n === 4 && !collection) {
      const guess = suggest();
      setCollection(guess);
      setSuggested(guess);
    }
    setStep(n);
    setAsk(false);
    setSelErr("");
    setSignInError("");
  };

  const locked = busy || ask || !!waiting;
  const dirty = step > 1 && !(options.connector && step === 2) && !(options.connection && step === 3 && !selection.length);
  const close = () => {
    if (waiting) return pending.current?.cancel();
    if (busy) return;
    if (ask) return setAsk(false);
    if (!dirty) return closeIngestionOverlay();
    setAsk(true);
  };

  /* ── App step ── */

  function pickApp(connector: string) {
    if (connector !== app) {
      setApp(connector);
      setAccount("");
      setConfErrors({});
    }
    // With exactly one connected account, it's preselected and the Account step is skipped (Change in the recap goes back).
    const own = (connections.data ?? []).filter((c) => c.connector === connector && c.state !== "AUTHORIZING");
    const skip = own.length === 1 && own[0]!.state === "ACTIVE";
    setSkipAccount(skip);
    if (skip) setAccount(own[0]!.name ?? "");
    goto(skip ? 3 : 2);
  }

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
      if (existing) toast(`Đã kết nối lại ${appName(app)}`);
      else {
        toast(`Đã kết nối ${accountLabel(connection)}`);
        goto(3);
      }
    } catch (error) {
      if (error instanceof ApiError) setSignInError(errorMessage(error));
      else if (!isCancelled(error)) setSignInError(`${provider} chưa xác nhận việc đăng nhập. Hãy thử lại hoặc dùng tài khoản khác.`);
    } finally {
      pending.current = null;
      setWaiting("");
    }
  }

  async function verifyConfluence() {
    const found = confluenceErrors(conf, hosts);
    setConfErrors(found);
    if (Object.keys(found).length) return focusInvalid();
    setBusy(true);
    try {
      const connection = await connectConfluence(id, conf);
      refresh();
      setConf(EMPTY_CONFLUENCE);
      setAccount(connection.name ?? "");
      toast(`Đã kết nối ${accountLabel(connection)}`);
      goto(3);
    } catch (error) {
      setConfErrors({ token: error instanceof TokenRejected ? error.message : errorMessage(error) });
      focusInvalid();
    } finally {
      setBusy(false);
    }
  }

  /* ── Submit ── */

  function newNameError(v: string): string {
    const n = v.trim();
    if (!n) return "Đặt tên cho kho tài liệu mới.";
    if ((collections.data ?? []).some((b) => (b.displayName ?? "").trim().toLowerCase() === n.toLowerCase())) return "Đã có kho tài liệu với tên này.";
    return "";
  }

  async function submit() {
    const next: typeof errors = {};
    if (!collection) next.collection = "Chọn nơi lưu tài liệu.";
    if (collection === NEW_COLLECTION) {
      const e = newNameError(newName);
      if (e) next.newName = e;
    }
    setErrors(next);
    if (Object.keys(next).length) return focusInvalid();
    setBusy(true);
    try {
      let target = collection;
      if (collection === NEW_COLLECTION) {
        // A new collection made here starts like one made from New collection: everyone can see it.
        const base = await createBase(id, { displayName: newName.trim(), discoverable: true });
        target = base.name ?? "";
        const iam = await getItemIamPolicy(id, target);
        await setItemIamPolicy(id, target, withGeneralAccess(iam, "workspace"));
        void qc.invalidateQueries({ queryKey: knowledgeKeys.items(id) });
      }
      const taken = (sources.data ?? []).map(sourceName);
      const created: Source[] = [];
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
      toast(created.length === 1 ? "Đã kết nối. Đã bắt đầu đồng bộ lần đầu." : `Đã kết nối ${plural(created.length, "source")}. Đã bắt đầu các lần đồng bộ đầu tiên.`, {
        action: first ? { label: "Xem", onPress: () => router.push(sourceHref(first.name)) } : undefined,
      });
    } catch (error) {
      setBusy(false);
      toast(errorMessage(error), { tone: "danger" });
    }
  }

  function next() {
    if (locked) return;
    if (step === 1) return app && pickApp(app);
    if (step === 2) {
      if (account === NEW_ACCOUNT) return app === CONFLUENCE ? void verifyConfluence() : void signIn();
      if (connections.byName.get(account)?.state !== "ACTIVE") return setSignInError("Hãy chọn một tài khoản đã kết nối, hoặc kết nối tài khoản mới.");
      return goto(3);
    }
    if (step === 3) {
      if (!picked.length) return setSelErr(app === GOOGLE_DRIVE ? "Chọn ít nhất một thư mục." : "Chọn ít nhất một cộng đồng hoặc trang.");
      return goto(4);
    }
    void submit();
  }

  /* ── Render ── */

  const stepper = (
    <ol className="src-stepper" aria-label="Các bước">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "current" : "todo";
        const inner = (
          <>
            <span className="src-stepper__dot">{n < step ? <Check className="i i-xs" aria-hidden /> : n}</span>
            <span className="src-stepper__label">{label}</span>
          </>
        );
        return (
          <li key={label} className={`src-stepper__step src-stepper__step--${state}`} aria-current={n === step ? "step" : undefined}>
            {state === "done" && !locked ? (
              <button type="button" className="src-stepper__btn" onClick={() => goto(n)}>
                {inner}
              </button>
            ) : (
              <span className="src-stepper__btn">{inner}</span>
            )}
          </li>
        );
      })}
    </ol>
  );

  const description =
    step === 1
      ? "Tài liệu nằm ở đâu? Hãy chọn ứng dụng đang lưu chúng."
      : step === 2
        ? `BoMesh nên đọc từ tài khoản ${appName(app)} nào?`
        : step === 3
          ? `Chọn ${noun} cần đồng bộ. Các tệp mới bên trong sẽ tự động đồng bộ.`
          : "Chọn nơi lưu tài liệu và cách giữ chúng luôn cập nhật.";

  let body: ReactNode = null;
  if (step === 1)
    body = (
      <AppStep
        connectors={connectors.data}
        isLoading={connectors.isPending}
        error={connectors.isError ? connectors.error : null}
        retry={() => void connectors.refetch()}
        value={app}
        requested={requests.requested}
        onPick={pickApp}
        onRequested={() => void requests.refetch()}
      />
    );
  else if (step === 2) {
    body =
      waiting === "new" ? (
        <WaitingState title={`Hoàn tất đăng nhập bằng ${provider}`} description={`Một cửa sổ ${provider} đã mở. Hãy quay lại đây khi hoàn tất.`} />
      ) : (
        <div className="stack gap-8 src-choices">
          {signInError ? <Callout tone="danger" description={signInError} /> : null}
          <RadioGroup
            aria-label="Tài khoản"
            value={account}
            onChange={(v) => {
              setAccount(v);
              setSignInError("");
            }}
            isDisabled={busy || !!waiting}
            className="stack gap-8"
          >
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
                        {off ? "Quyền truy cập đã hết hạn — kết nối lại để sử dụng" : used ? `${plural(used, "source")} đang sử dụng` : "Đã kết nối"}
                      </span>
                    </span>
                    {off ? (
                      waiting === a.name ? (
                        <span className="row gap-6 t-sm muted src-choice__trail">
                          <Spinner size="sm" />
                          Đang chờ {provider}…
                        </span>
                      ) : (
                        <span className="src-choice__trail">
                          <Button size="sm" variant="secondary" isDisabled={busy || !!waiting} onPress={() => void signIn(a)}>
                            Kết nối lại
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
                    Kết nối tài khoản mới
                  </span>
                  <span className="choice__desc" style={{ display: "block" }}>
                    {app === CONFLUENCE ? "Dùng site Confluence và mã API." : `Đăng nhập bằng ${provider}.`}
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
        claims={claims}
        collectionName={(name) => collections.byName.get(name)?.displayName}
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
          const nextSel = toggleSelection(tree, selection, node, blocked);
          setSelection(nextSel);
          if (nextSel.length) setSelErr("");
        }}
        onClear={() => setSelection([])}
      />
    );
  } else {
    const first = picked[0];
    const content = first ? `${pathOf(tree, first)}${picked.length > 1 ? ` +${picked.length - 1}` : ""}` : "";
    const name = first ? sourceNameFor(tree, first, appKey(app), (sources.data ?? []).map(sourceName)) : "";
    const connection = connections.byName.get(account);
    const then = policy === "REVIEW_FIRST" ? "Lần đồng bộ đầu tiên gửi các tệp tìm thấy vào danh sách chờ duyệt." : "Lần đồng bộ đầu tiên công bố các tệp tìm thấy.";
    body = (
      <div className="stack gap-16">
        <div className="src-recap">
          <AppIcon app={appKey(app)} />
          <div className="grow src-min">
            <div className="medium truncate" translate="no">
              {name}
              {picked.length > 1 ? ` +${picked.length - 1}` : ""}
            </div>
            <div className="t-xs muted truncate" translate="no">
              {[accountLabel(connection), content].filter(Boolean).join(" · ")}
            </div>
          </div>
          {skipAccount ? (
            <LinkButton className="src-recap__change" onPress={() => goto(2)}>
              Thay đổi
            </LinkButton>
          ) : null}
        </div>
        <div className="field">
          <OptionSelect
            label="Kho tài liệu"
            value={collection}
            placeholder="Chọn kho tài liệu"
            isInvalid={!!errors.collection}
            options={[...collections.targets.map((b) => [b.name ?? "", b.displayName ?? ""] as const), [NEW_COLLECTION, "Kho tài liệu mới…"] as const]}
            onChange={(v) => {
              setCollection(v);
              setErrors((e) => ({ ...e, collection: undefined }));
            }}
          />
          {errors.collection ? (
            <div className="field-error" role="alert">
              <CircleAlert className="i" aria-hidden />
              <span>{errors.collection}</span>
            </div>
          ) : (
            <p className="description">
              {suggested && collection === suggested ? "Gợi ý dựa trên nội dung bạn chọn. Hãy đổi nếu nó thuộc về nơi khác." : "Những người xem được kho tài liệu này sẽ tìm thấy nội dung được đồng bộ vào đó."}
            </p>
          )}
        </div>
        {collection === NEW_COLLECTION ? (
          <TextField
            className="field"
            value={newName}
            onChange={(v) => {
              setNewName(v);
              if (errors.newName) setErrors((e) => ({ ...e, newName: newNameError(v) || undefined }));
            }}
            isRequired
            isInvalid={!!errors.newName}
            autoFocus
            fullWidth
          >
            <Label>Tên</Label>
            <Input placeholder="VD: Tài sản Marketing" onKeyDown={(e) => e.key === "Enter" && next()} />
            {errors.newName ? (
              <FieldError>{errors.newName}</FieldError>
            ) : (
              <Description>
                <span>{accessInfo("workspace", workspace).long}</span> <span>Bạn có thể đổi người được xem trong thẻ Quyền truy cập.</span>
              </Description>
            )}
          </TextField>
        ) : null}
        <div className="field">
          <span className="label">Tệp mới và đã thay đổi</span>
          <ChoiceGroup
            label="Tệp mới và đã thay đổi"
            value={policy}
            options={POLICY_CHOICES}
            onChange={setPolicy}
          />
          <p className="description">{then}</p>
        </div>
        <Disclosure icon={Clock} title="Lịch đồng bộ" summary={draftText(draft) + (draft.freq !== "manual" ? ` · ${tzShort(draft.tz)}` : "")}>
          <div className="stack gap-12">
            <ScheduleFields label="Tần suất đồng bộ" draft={draft} onChange={setDraft} />
            {draft.freq === "manual" ? <p className="description">Chỉ đồng bộ khi có người nhấn Đồng bộ ngay.</p> : null}
          </div>
        </Disclosure>
      </div>
    );
  }

  let start: ReactNode = null;
  let footer: ReactNode;
  if (ask) {
    start = <span className="t-sm medium fg">Bỏ nguồn này?</span>;
    footer = (
      <>
        <Button variant="secondary" onPress={() => setAsk(false)}>
          Tiếp tục chỉnh sửa
        </Button>
        <Button variant="danger" autoFocus onPress={closeIngestionOverlay}>
          Bỏ
        </Button>
      </>
    );
  } else if (waiting)
    footer = (
      <Button variant="ghost" onPress={() => pending.current?.cancel()}>
        Hủy
      </Button>
    );
  else {
    const back = (
      <Button variant="ghost" isDisabled={busy} onPress={() => goto(step === 3 && skipAccount ? 1 : step - 1)}>
        <ArrowLeft className="i" aria-hidden />
        Quay lại
      </Button>
    );
    if (step === 1)
      footer = (
        <>
          <Button variant="ghost" onPress={close}>
            Hủy
          </Button>
          {app ? (
            <Button key="next-1" variant="primary" onPress={next}>
              Tiếp tục
            </Button>
          ) : null}
        </>
      );
    else if (step === 2)
      footer = (
        <>
          {back}
          {account === NEW_ACCOUNT && app !== CONFLUENCE ? (
            <Button key="next-2-oauth" variant="primary" onPress={next}>
              Tiếp tục với {provider}
              <ExternalLink className="i" aria-hidden />
            </Button>
          ) : account === NEW_ACCOUNT ? (
            <Button key="next-2-verify" variant="primary" isPending={busy} onPress={next}>
              Xác minh và tiếp tục
            </Button>
          ) : (
            <Button key="next-2" variant="primary" onPress={next}>
              Tiếp tục
            </Button>
          )}
        </>
      );
    else if (step === 3) {
      start = <span aria-live="polite">{picked.length ? `Đã chọn ${plural(picked.length, "item")}` : "Chưa chọn gì"}</span>;
      footer = (
        <>
          {back}
          <Button key="next-3" variant="primary" onPress={next}>
            Tiếp tục
          </Button>
        </>
      );
    } else
      footer = (
        <>
          {back}
          <Button key="next-4" variant="primary" isPending={busy} onPress={next}>
            <Plug className="i" aria-hidden />
            Kết nối và đồng bộ
          </Button>
        </>
      );
  }

  return (
    <Modal.Backdrop isOpen isDismissable={!waiting && !busy} isKeyboardDismissDisabled={!!waiting || busy} onOpenChange={(o) => !o && close()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          {waiting ? null : <Modal.CloseTrigger aria-label="Đóng" />}
          <Modal.Header>
            <div className="row gap-12">
              {app ? (
                <AppIcon app={appKey(app)} size="lg" className="modal__icon" />
              ) : (
                <span className="modal__icon" aria-hidden>
                  <Plug />
                </span>
              )}
              <div className="grow src-min">
                <Modal.Heading>Thêm nguồn dữ liệu</Modal.Heading>
                <p className="modal__description">{description}</p>
              </div>
            </div>
            {stepper}
          </Modal.Header>
          <Modal.Body>
            <div className="src-wiz src-wiz--steps">{body}</div>
          </Modal.Body>
          <Modal.Footer>
            {start ? <div className="modal__footer-start t-sm muted">{start}</div> : null}
            {footer}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/* ═══════════════ Step 1: App ═══════════════ */

/** Available apps as tiles; apps that aren't available yet collapse into one quiet "Request it" line. */
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
  if (error) return <ErrorState error={error} onRetry={retry} />;
  if (isLoading) return <SkeletonRows rows={2} />;
  const all = connectors ?? [];
  const on = all.filter((c) => c.state === "ACTIVE");
  const off = all.filter((c) => c.state !== "ACTIVE");
  if (!all.length) return <EmptyState icon={Search} title="Chưa có ứng dụng nào" description="Hãy đề nghị quản trị viên nền tảng bật Google Drive hoặc Confluence." compact />;

  const request = async (c: Connector) => {
    try {
      await requestConnector(id, c);
      toast(`Đã gửi yêu cầu ${appName(c.name, all)} tới quản trị viên nền tảng`);
      onRequested();
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  };

  return (
    <>
      <div className="src-apps" role="radiogroup" aria-label="Ứng dụng">
        {on.map((c) => (
          <button key={c.name} type="button" className="card card--action src-app" role="radio" aria-checked={value === c.name} onClick={() => onPick(c.name ?? "")}>
            <AppIcon app={appKey(c.name)} size="lg" />
            <span className="src-app__name">{appName(c.name, all)}</span>
            <span className="src-app__desc">{c.description}</span>
            {value === c.name ? (
              <span className="src-app__check" aria-hidden>
                <Check className="i i-xs" />
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {off.length ? (
        <div className="src-more-apps">
          <span>{`Cần ${off.map((c) => appName(c.name, all)).join(", ")} hoặc ứng dụng khác?`}</span>
          <Dropdown>
            <Button variant="ghost" size="sm" className="src-more-apps__btn">
              Yêu cầu
              <ChevronDown className="i" aria-hidden />
            </Button>
            <Dropdown.Popover placement="bottom start">
              <Dropdown.Menu
                aria-label="Yêu cầu một ứng dụng"
                disabledKeys={off.filter((c) => requested.has(c.name ?? "")).map((c) => c.name ?? "")}
                onAction={(key) => {
                  const c = off.find((x) => x.name === key);
                  if (c) void request(c);
                }}
              >
                <Dropdown.Section>
                  <Header>Đề nghị quản trị viên nền tảng bổ sung</Header>
                  {off.map((c) => (
                    <Dropdown.Item key={c.name} id={c.name ?? ""} textValue={appName(c.name, all)}>
                      <AppIcon app={appKey(c.name)} size="sm" />
                      <Label className="grow">{appName(c.name, all)}</Label>
                      {requested.has(c.name ?? "") ? <Description>Đã yêu cầu</Description> : null}
                    </Dropdown.Item>
                  ))}
                </Dropdown.Section>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      ) : null}
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
  claims,
  collectionName,
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
  claims: ReadonlyMap<string, Source>;
  collectionName: (name: string) => string | undefined;
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
  const blocked = (nodeId: string) => claims.has(nodeId);

  const rows = (parent: string, depth: number, force: boolean): ReactNode[] =>
    (tree.children[parent] ?? []).flatMap((nodeId): ReactNode[] => {
      const node = tree.nodes[nodeId]!;
      const hit = !!needle && node.name.toLowerCase().includes(needle);
      if (needle && !force && !matches(tree, nodeId, needle)) return [];
      const Icon = app === GOOGLE_DRIVE ? Folder : node.type === "page" ? FileText : BookOpen;
      const label = (
        <span className="row gap-8 src-min checkbox__label">
          <Icon className="i i-sm muted" aria-hidden />
          <span className="truncate" translate="no">
            {node.name}
          </span>
        </span>
      );
      const style = { "--depth": depth } as CSSProperties;
      // Already synced by another source: shown, not pickable, with where it goes (its documents are already there).
      const taken = claimOf(tree, nodeId, claims);
      if (taken)
        return [
          <div key={nodeId} className="src-tree__row is-taken" style={style}>
            <span className="src-tree__tog" aria-hidden />
            <Checkbox isSelected={false} isDisabled>
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                {label}
              </Checkbox.Content>
            </Checkbox>
            <Tip content={`${sourceName(taken)} đã đồng bộ mục này`}>
              <span className="src-tree__taken truncate">{`Trong ${collectionName(taken.targetCollection) ?? "kho tài liệu khác"}`}</span>
            </Tip>
          </div>,
        ];
      const kids = tree.children[nodeId];
      const isOpen = open.has(nodeId) || (!!needle && !!kids?.some((k) => matches(tree, k, needle)));
      const state = checkState(tree, selection, nodeId, blocked);
      const out: ReactNode[] = [
        <div key={nodeId} className={clsx("src-tree__row", state !== "none" && "is-on")} style={style}>
          {node.hasChildren ? (
            <Button isIconOnly variant="ghost" size="sm" className="src-tree__tog button--muted" aria-expanded={isOpen} aria-label={`${isOpen ? "Thu gọn" : "Mở rộng"} ${node.name}`} onPress={() => onToggleOpen(nodeId)}>
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
              {label}
            </Checkbox.Content>
          </Checkbox>
        </div>,
      ];
      if (isOpen && kids) out.push(...rows(nodeId, depth + 1, force || hit));
      if (isOpen && loadError?.node === nodeId)
        out.push(
          <div key={`${nodeId}-err`} className="src-tree__row t-sm text-danger" style={{ "--depth": depth + 1 } as CSSProperties}>
            {errorMessage(loadError.error)}
            <Button variant="ghost" size="sm" onPress={() => onRetry(nodeId)}>
              Thử lại
            </Button>
          </div>,
        );
      return out;
    });

  let content: ReactNode;
  // The provider's own reason ("The site could not list its resources.") beats the generic copy, even on 503.
  if (loadError?.node === ROOT)
    content = (
      <ErrorState error={loadError.error} description={loadError.error instanceof ApiError ? serverText(loadError.error.message) : undefined} onRetry={() => onRetry(ROOT)} boxed={false} />
    );
  else if (!tree.children[ROOT]) content = <SkeletonRows rows={4} />;
  else {
    const list = rows(ROOT, 0, false);
    content = list.length ? list : <EmptyState icon={Search} title={needle ? "Không có kết quả" : `Không tìm thấy ${noun}`} description={needle ? "Hãy thử tên khác." : "Tài khoản này không truy cập được nội dung nào để đồng bộ."} compact />;
  }

  return (
    <>
      <div className="toolbar src-tree-bar">
        <SearchInput value={q} onChange={onQuery} placeholder={`Tìm kiếm ${noun}`} />
        {picked.length ? (
          <div className="toolbar__end">
            <Button variant="ghost" size="sm" onPress={onClear}>
              Bỏ chọn
            </Button>
          </div>
        ) : null}
      </div>
      <div className={clsx("src-tree", selErr && "is-invalid")} role="group" aria-label="Nội dung đồng bộ" aria-describedby={selErr ? "src-sel-err" : undefined}>
        {content}
      </div>
      {selErr ? (
        <div className="field-error mt-8" id="src-sel-err" role="alert">
          <CircleAlert className="i" aria-hidden />
          <span>{selErr}</span>
        </div>
      ) : null}
    </>
  );
}
