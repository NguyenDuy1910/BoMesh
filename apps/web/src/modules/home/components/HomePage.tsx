"use client";

import { BookOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { EmptyState, ErrorState, Page, toast } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace";
import { NewChatBox } from "@/modules/chat/components/NewChatBox";
import { useAssistant } from "@/modules/chat/queries";
import { ContributeButton } from "@/modules/knowledge/components/KnowledgeHeader";
import { useItemsByName, useKnowledgeModel, useRecentItems } from "@/modules/knowledge/queries";
import { useConversations } from "@/modules/projects";

import type { MemberHome } from "../api";
import { useMemberHome } from "../queries";
import { ExploreByDomain, GettingStarted, JumpBackIn, PickedForYou, type Pick, type RecentDoc, type StartSteps } from "./HomeSections";

const DAY = 86_400_000;
/** How long a member counts as new (Getting started). */
const NEW_FOR = 30 * DAY;
const PICKS = 4;

/** Getting started hidden, per person and workspace on this device (like the product tour's seen flag). */
const startKey = (user: string, workspace: string) => `bomesh.gettingStarted.${user}:${workspace}`;

function useStartHidden(user: string | undefined, workspace: string) {
  const key = user ? startKey(user, workspace) : "";
  const [hidden, setHidden] = useState(false);
  useEffect(() => setHidden(!!key && !!window.localStorage.getItem(key)), [key]);
  const set = useCallback(
    (next: boolean) => {
      if (!key) return;
      if (next) window.localStorage.setItem(key, String(Date.now()));
      else window.localStorage.removeItem(key);
      setHidden(next);
    },
    [key],
  );
  return [hidden, set] as const;
}

/** By display name: people have no separate given name, and which word is the given one depends on the name's order. */
function greeting(name: string) {
  const h = new Date().getHours();
  return h < 12 ? `Good morning, ${name}` : h < 18 ? `Good afternoon, ${name}` : `Good evening, ${name}`;
}

/**
 * /home — where everyone starts (preview `features/home.js`, docs/HOME.md): the greeting and the one composer on the plain
 * page, then Getting started (members in their first 30 days) or Jump back in, Picked for you and Explore by domain.
 * Everything comes from the member's Home read model (`GetMemberHome`); the full tree of collections is Knowledge › Map.
 */
export function HomePage() {
  const ws = useWorkspace();
  const session = useSession();
  const home = useMemberHome();
  const assistant = useAssistant();
  const [hidden, setHidden] = useStartHidden(session?.user.name, ws.id);

  const data = home.data;
  const name = session?.user.displayName || ws.member.displayName || session?.user.email || "";
  const joined = Date.parse(data?.joinTime ?? "");
  const isNew = !!data && Number.isFinite(joined) && Date.now() - joined < NEW_FOR;
  const steps = {
    asked: (data?.counts?.conversationCount ?? 0) > 0,
    opened: (data?.continue?.recentItems?.length ?? 0) > 0,
    saved: (data?.counts?.savedItemCount ?? 0) > 0,
  };
  const starting = isNew && !hidden;
  const welcome = starting && !(steps.asked && steps.opened && steps.saved);

  const hide = () => {
    setHidden(true);
    toast("Getting started hidden", { undo: () => setHidden(false) });
  };

  return (
    <Page className="home is-entering">
      <header className="home-hero">
        <h1 className="home-hero__title">{welcome ? `Welcome, ${name}` : greeting(name)}</h1>
        {welcome ? (
          <p className="home-hero__lead">{`This is where ${ws.workspace.displayName ?? ""} keeps its knowledge. Ask anything, or start with what’s picked for you below.`}</p>
        ) : null}
        <div className="home-ask" id="home-ask">
          <NewChatBox placeholder={assistant.data?.welcomeMessage || undefined} autoFocus />
        </div>
      </header>
      {home.isPending ? (
        <HomeSkeleton />
      ) : home.isError || !data ? (
        <ErrorState error={home.error} onRetry={home.refetch} />
      ) : !(data.counts?.documentCount ?? 0) ? (
        <NoKnowledge />
      ) : (
        <HomeBody data={data} starting={starting} steps={steps} onHide={hide} />
      )}
    </Page>
  );
}

function HomeBody({ data, starting, steps, onHide }: { data: MemberHome; starting: boolean; steps: StartSteps; onHide: () => void }) {
  const { toResource } = useKnowledgeModel();
  const recommended = useMemo(() => (data.recommended ?? []).filter((r) => r.item?.item).slice(0, PICKS), [data.recommended]);
  const recentItems = data.continue?.recentItems ?? [];
  const conversations = useConversations(!starting);
  const conversation = starting ? undefined : (conversations.data ?? []).find((c) => !!c.lastMessageTime);
  const recentNames = recentItems.slice(0, conversation ? 3 : 4).map((r) => r.item);
  const recentViews = useRecentItems(8, { enabled: !starting });
  const items = useItemsByName([...recommended.map((r) => r.item?.item), ...(starting ? [] : recentNames)]);

  const picks: Pick[] = recommended.flatMap((r) => {
    const item = items.items.get(r.item?.item ?? "");
    return item ? [{ resource: toResource(item), reason: r.reason }] : [];
  });
  const viewed = new Map((recentViews.data ?? []).map((v) => [resourceId(v.item), v.viewTime]));
  const docs: RecentDoc[] = recentNames.flatMap((n) => {
    const item = items.items.get(n ?? "");
    return item ? [{ resource: toResource(item), at: viewed.get(resourceId(n)) }] : [];
  });
  const loadingCards = items.isPending;

  return (
    <>
      {starting ? <GettingStarted steps={steps} first={picks[0]?.resource} onHide={onHide} /> : <JumpBackIn conversation={conversation} docs={docs} />}
      {loadingCards ? (
        <div className="home-skel" aria-busy="true" aria-label="Loading">
          <div className="home-picks__grid">
            {recommended.map((r) => (
              <span key={r.item?.item} className="skeleton home-skel__card" />
            ))}
          </div>
        </div>
      ) : (
        <PickedForYou picks={picks} starters={data.starterPrompts ?? []} />
      )}
      <ExploreByDomain domains={(data.topicDomains ?? []).filter((d) => (d.documentCount ?? 0) > 0)} />
    </>
  );
}

function HomeSkeleton() {
  return (
    <div className="home-skel" aria-busy="true" aria-label="Loading">
      <div className="home-picks__grid">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="skeleton home-skel__card" />
        ))}
      </div>
      <div className="home-domains__grid">
        {[0, 1, 2].map((i) => (
          <span key={i} className="skeleton home-skel__card home-skel__card--short" />
        ))}
      </div>
    </div>
  );
}

/** No published knowledge: the composer stays (the assistant can still be asked). */
function NoKnowledge() {
  const { can, member } = useWorkspace();
  const canContribute = can("contributions.create") || !!member.personalCollection;
  return (
    <EmptyState
      icon={BookOpen}
      boxed
      title="Your workspace has no published knowledge yet"
      description={
        canContribute
          ? "Contribute documents for review. Once they’re published, Home shows what’s here and what to read first."
          : "Home fills in as documents are published. You can still ask the assistant."
      }
      actions={canContribute ? <ContributeButton variant="primary" /> : null}
    />
  );
}
