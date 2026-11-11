import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import {
  Composer,
  type ComposerDraft,
  toAgentOptions,
  toGroupOptions,
  withGroupMembers,
} from "@/components/channels/composer";
import { WorkingNow } from "@/components/channels/working-now";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import {
  BearMascot,
  WorkbenchEmpty,
} from "@/components/layout/workbench-empty";
import { StarterSuggestions } from "@/components/starter-tour/starter-suggestions";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions, isSharedWithYou } from "@/lib/agents/queries";
import type { AuthenticatedUser } from "@/lib/auth/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  beginPendingStart,
  endPendingStart,
  onFailedStart,
  pendingStartPath,
  stashFailedStart,
  takeFailedStart,
} from "@/lib/channels/pending-start";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  CoworkerRoutingRefusedError,
  routeMessage,
} from "@/lib/channels/route";
import { useStartChannel } from "@/lib/channels/start";
import { appConfig } from "@/lib/generated/application-config";
import { newId } from "@/lib/new-id";
import { useAnyBotSkillCommands } from "@/lib/plugins/skill-commands";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";

/** How many Bots the home page shows before pointing to the rest. Two rows of two. */
const EXPLORE_SHOWN = 4;

export const Route = createFileRoute("/_authed/_app/")({
  /*
   * `ask`: words to start the box with, as Teach a Bot's Try it hands over a task a Bot just learned. Only put in the
   * box: nothing is sent until the person sends it.
   */
  validateSearch: z.object({ ask: z.string().max(2000).optional() }),
  component: RouteComponent,
});

/**
 * The home page's heading. The first time somebody with a name arrives, it greets them by it; after
 * that, or without a name worth using, it is the plain prompt. Upstream's `firstConversationGreeting`
 * (`lib/auth/greeting.ts`) with the same rule, said in Chinese.
 */
function homeGreeting(
  user: AuthenticatedUser | null | undefined,
  noConversations: boolean,
): string {
  const name = user?.name?.trim();
  if (!noConversations || !name || user?.needsName || name === user?.email)
    return "开始新对话";
  return `${name}，你好！今天想做点什么？`;
}

function RouteComponent() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const {
    data: agents,
    isPending: loading,
    isError: failed,
  } = useQuery(agentListQueryOptions());
  const explore = agents?.filter(isSharedWithYou);
  // Groups expand into their members in the `@` menu (spec B1); a failed read just lists no Groups.
  const groups = useQuery(wakerGroupsQueryOptions()).data;
  const roster = toAgentOptions(agents);
  const { start, startChosen, pending } = useStartChannel();
  const router = useRouter();
  const navigate = useNavigate();
  // A start that failed behind its placeholder comes back here: its words in the box, its reason
  // under it, the way a failed send always left them. Taken on mount, and again whenever one fails
  // while this page is open (somebody who came back here before it failed is looking at it).
  const [restored, setRestored] = useState(takeFailedStart);
  // Read once, as the box reads its words once: the words a link handed over (`ask`).
  const ask = useSearch({ strict: false }).ask;
  const [asked] = useState(ask);
  const [restores, setRestores] = useState(0);
  const [error, setError] = useState<string | null>(restored?.error ?? null);
  /*
   * Whether the person has typed in the box since it was last filled. A start that fails while they
   * are writing something else does not overwrite it: it stays stashed, for the next home page.
   */
  const typed = useRef(false);
  useEffect(
    () =>
      onFailedStart(() => {
        if (typed.current) return;
        const failed = takeFailedStart();
        if (!failed) return;
        setRestored(failed);
        setRestores((count) => count + 1);
        setError(failed.error);
      }),
    [],
  );

  /** Default recipient when the composer draft has no mention. */
  /*
   * Every skill any of the person's Bots offers. The Bot is not known until it is chosen with `@` or
   * routed to after sending, so the menu offers them all and sending picks a Bot that has the one
   * used. Without this the box fell back to a placeholder command no Bot has.
   */
  const { commands: skillCommands } = useAnyBotSkillCommands(
    agents?.map((agent) => agent.id) ?? [],
  );
  const fallback = defaultAgentProfile(
    agents,
    agents?.find((agent) => agent.visibility === "public"),
  );

  /**
   * Pick the Bot and make the channel behind the placeholder `pendingId`.
   *
   * A channel is pinned to one coworker for the life of its thread, so the coworker is chosen now,
   * before it is created. An `@` is an explicit choice and is honoured as-is. With no `@`, the
   * message is routed to the coworker it is for; if that routing cannot run, it falls back to the
   * same default the composer used to always use.
   *
   * Runs on after this page has unmounted, which is the point. A failure goes back to the home
   * composer with the words and the reason, and the person is taken there only if they are still
   * looking at the placeholder; otherwise the next home page they open shows it.
   */
  const startBehind = async (pendingId: string, draft: ComposerDraft) => {
    // A `/` skill stays at the start of the words, where the server finds it and gives the Bot its
    // instructions, only if the Bot holds it (server/src/plugins/picked-skill.ts).
    try {
      if (draft.agentId) {
        // Recorded and started as one sequence, shared with `/channel/new`: the person already
        // decided, and the trail has to say so wherever they decided it.
        await startChosen(draft.agentId, draft.text, undefined, pendingId);
        return;
      }
      let agentId: string | undefined;
      try {
        agentId = (await routeMessage(draft.text, undefined, draft.commandIds))
          .agentId;
      } catch (caught) {
        if (
          draft.commandIds.length ||
          caught instanceof CoworkerRoutingRefusedError
        )
          throw caught;
        agentId = fallback?.id;
      }
      if (!agentId) throw new Error("没有可以接收这条消息的员工，请刷新页面。");
      await start(agentId, draft.text, undefined, pendingId);
    } catch (caught) {
      stashFailedStart({
        text: draft.text,
        error: caught instanceof Error ? caught.message : "对话没能开始。",
      });
      if (router.state.location.pathname === pendingStartPath(pendingId))
        await navigate({ replace: true, to: "/" });
    } finally {
      endPendingStart(pendingId);
    }
  };

  return (
    <>
      <SidebarToggleBar />
      {/*
       * The welcome (docs/design/ios-studio): 熊宝 himself, the product's name as a quiet line, and an
       * open heading — no card around it, so the composer below is the one thing on the page with a
       * frame. Scrolls inside the pane on a short window rather than clipping the list under it.
       */}
      <div className="flex w-full min-h-0 flex-1 flex-col items-center overflow-y-auto px-[13px] pt-[6vh] pb-10 md:justify-center md:px-6 md:pt-0">
        <div className="flex flex-col items-center text-center">
          <BearMascot mood="happy" size={56} />
          <h2 className="mt-[14px] font-mono text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
            {appConfig.brand.productName}
          </h2>
          <h1 className="mt-[6px] font-bold text-[28px] leading-[1.15] tracking-tight">
            {homeGreeting(
              user,
              channels.isSuccess && channels.data.length === 0,
            )}
          </h1>
        </div>
        <div
          className="mt-[26px] w-full flex flex-col items-center"
          onKeyDownCapture={() => {
            typed.current = true;
          }}
          onPasteCapture={() => {
            typed.current = true;
          }}
        >
          <StarterSuggestions
            agentId={fallback?.id}
            disabled={pending}
            onSelect={async (message) => {
              if (!fallback) return;
              await startChosen(fallback.id, message);
            }}
          />
          <Composer
            agents={withGroupMembers(roster, toGroupOptions(groups, roster))}
            commands={skillCommands}
            className="w-full max-w-2xl"
            disabled={!fallback}
            // The box reads its words once, when it mounts; a start that fails while this page is
            // open is a new box with them in it.
            key={restores}
            {...(restored
              ? { initialValue: restored.text }
              : asked
                ? { initialValue: asked, autoFocus: true }
                : {})}
            onSubmit={async (draft) => {
              // The conversation opens NOW, as a placeholder showing the message, and the Bot is
              // picked and the channel made behind it; see `pending-start.ts`. Waiting here for
              // both is what kept send looking dead for seconds.
              setError(null);
              const pendingId = newId();
              beginPendingStart(pendingId, {
                text: draft.text,
                agentId: draft.agentId,
              });
              await navigate({
                params: { startId: pendingId },
                to: "/start/$startId",
              });
              void startBehind(pendingId, draft);
            }}
          />
          {fallback ? (
            // Said out loud: a message that silently reaches somebody you did not choose is the
            // kind of surprise that costs trust the first time it happens.
            <p className="mt-2 w-full max-w-2xl text-[12px] text-faint text-center">
              会自动交给对应的员工。输入 <code>@</code> 可以自己选。
            </p>
          ) : null}
          {error ? (
            <p
              className="mt-2 w-full max-w-2xl rounded-[12px] border border-signal/30 bg-signal-soft px-3 py-2 text-[13px] text-signal-ink"
              role="alert"
            >
              {error}
            </p>
          ) : failed && agents === undefined ? (
            // The composer above is `disabled={!fallback}`, and a failed query does not by
            // itself mean `fallback` is undefined: TanStack Query keeps its last good `data`
            // across a failed background refetch, and `!fallback` alone is also true of a query
            // that loaded successfully and genuinely returned zero agents — a case where nobody
            // failed to load anything. `agents === undefined` is the one condition that is only
            // true when the query has never once returned successfully, so this alert can only
            // ever claim a load failure while that is actually what happened.
            <p
              className="mt-2 w-full max-w-2xl rounded-[12px] border border-signal/30 bg-signal-soft px-3 py-2 text-[13px] text-signal-ink"
              role="alert"
            >
              读不到你的员工，所以暂时没有人可以接收这条消息。
            </p>
          ) : null}
        </div>
        {/*
         * Up to four Bots, two to a row, as compact cards that fill the column. A teaser under the
         * composer, not the place to browse: more than four would push the composer up every time
         * somebody shared another Bot, so the rest are one "All Bots" away. Every state below
         * reserves the same two rows, so the composer above it does not move when the list settles.
         */}
        <div className="mt-[42px] w-full max-w-2xl">
          {loading ? (
            <>
              <h2 className="font-bold text-[15px]">发现员工</h2>
              <Skeleton className="mt-4 h-[140px] rounded-[14px]" />
            </>
          ) : explore?.length ? (
            // Wins over `failed`: a failed background refetch does not clear TanStack Query's
            // cached `data`, so a stale list here beats an error card claiming there is
            // nothing to explore, which would be false while this list is still populated.
            <section aria-labelledby="explore-agents-heading">
              <div className="flex flex-row items-center justify-between gap-4">
                <h2
                  id="explore-agents-heading"
                  className="font-bold text-[15px]"
                >
                  发现员工
                </h2>
                {explore.length > EXPLORE_SHOWN ? (
                  <Link
                    className="text-[13px] text-muted-foreground hover:text-foreground"
                    to="/bots"
                  >
                    全部员工
                  </Link>
                ) : null}
              </div>
              <ul className="mt-4 grid min-h-[140px] grid-cols-1 content-start gap-3 sm:grid-cols-2">
                {explore.slice(0, EXPLORE_SHOWN).map((agent) => (
                  <li className="min-w-0" key={agent.id}>
                    <Link search={{ agent: agent.id }} to="/channel/new">
                      <AgentCard agent={agent} appearance="row" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : failed && agents === undefined ? (
            // `agents === undefined` narrows this to "the query has never once returned
            // successfully" — not merely "the last request errored". `?.length` alone can't
            // tell that apart from a slice that loaded and is genuinely empty: TanStack Query
            // never clears `data` on a failed background refetch, so once the query has
            // resolved even one response, `agents` stays defined and `explore`'s emptiness is a
            // fact about that response, not a symptom of the failure. Rendering the destructive
            // card there would say the opposite of what a populated composer beside it (still
            // working off that same, successfully loaded `agents`) proves.
            <>
              <h2 className="font-bold text-[15px]">发现员工</h2>
              <Empty
                className="mt-4 h-[140px] rounded-[14px] border border-signal/30 border-dashed bg-signal-soft"
                role="alert"
              >
                <EmptyHeader>
                  <EmptyTitle className="text-signal-ink text-[14px]">
                    读不到共享给你的员工。
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            </>
          ) : (
            // Reached both when the query never failed and `explore` is genuinely empty, and
            // when it failed but `agents` is defined — a loaded, empty slice either way. Same
            // plain copy for both: an empty roster is a fact, not an error.
            <>
              <h2 className="font-bold text-[15px]">发现员工</h2>
              <WorkbenchEmpty
                className="mt-4 h-[140px] min-h-0 rounded-[14px] border border-border border-dashed"
                description="同事把员工共享给你之后，会出现在这里。"
                mood="cute"
                title="还没有人把员工共享给你。"
              />
            </>
          )}
        </div>
      </div>
      {/* A Bot already working somewhere, and the way to it. Nothing while every Bot is idle. */}
      <WorkingNow channels={channels.data} />
    </>
  );
}
