import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AgentCard } from "@/components/agents/agent-card";
import {
  Composer,
  toAgentOptions,
  toGroupOptions,
  withGroupMembers,
} from "@/components/channels/composer";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import {
  BearMascot,
  WorkbenchEmpty,
} from "@/components/layout/workbench-empty";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions, isSharedWithYou } from "@/lib/agents/queries";
import { routeMessage } from "@/lib/channels/route";
import { useStartChannel } from "@/lib/channels/start";
import { appConfig } from "@/lib/generated/application-config";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";

export const Route = createFileRoute("/_authed/_app/")({
  component: RouteComponent,
});

function RouteComponent() {
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
  const [error, setError] = useState<string | null>(null);

  /** Default recipient when the composer draft has no mention. */
  const fallback = defaultAgentProfile(
    agents,
    agents?.find((agent) => agent.visibility === "public"),
  );

  return (
    <>
      <SidebarToggleBar />
      {/*
       * The welcome (docs/design/ios-studio): 熊宝 himself, the product's name as a quiet line, and an
       * open heading — no card around it, so the composer below is the one thing on the page with a
       * frame. Scrolls inside the pane on a short window rather than clipping the carousel.
       */}
      <div className="flex w-full min-h-0 flex-1 flex-col items-center overflow-y-auto px-[13px] pt-[6vh] pb-10 md:justify-center md:px-6 md:pt-0">
        <div className="flex flex-col items-center text-center">
          <BearMascot mood="happy" size={56} />
          <h2 className="mt-[14px] font-mono text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
            {appConfig.brand.productName}
          </h2>
          <h1 className="mt-[6px] font-bold text-[28px] leading-[1.15] tracking-tight">
            开始新对话
          </h1>
        </div>
        <div className="mt-[26px] w-full flex flex-col items-center">
          <Composer
            agents={withGroupMembers(roster, toGroupOptions(groups, roster))}
            className="w-full max-w-2xl"
            disabled={!fallback}
            onSubmit={async (draft) => {
              // A channel is pinned to one coworker for the life of its thread, so the coworker is
              // chosen now, before it is created. An `@` is an explicit choice and is honoured as-is.
              // With no `@`, the message is routed to the coworker it is for; if that routing cannot
              // run, it falls back to the same default the composer used to always use.
              setError(null);
              try {
                if (draft.agentId) {
                  // Recorded and started as one sequence, shared with `/channel/new`: the person
                  // already decided, and the trail has to say so wherever they decided it.
                  await startChosen(draft.agentId, draft.text);
                  return;
                }
                let agentId: string | undefined;
                try {
                  agentId = (await routeMessage(draft.text)).agentId;
                } catch {
                  agentId = fallback?.id;
                }
                if (!agentId) return;
                await start(agentId, draft.text);
              } catch (caught) {
                setError(
                  caught instanceof Error ? caught.message : "对话没能开始。",
                );
                throw caught;
              }
            }}
            pending={pending}
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
         * A carousel rather than the wrapping grid `/agents` uses, and the difference is on purpose.
         * This is a one-row teaser under the composer: a grid that wrapped here would push the row
         * down the page every time somebody shared another Bot. `/agents` is the browse surface and
         * wraps.
         *
         * What it replaces was `flex flex-row` with no wrap over cards that have no `shrink-0`, so
         * the fifth public Bot squeezed all five — the same failure `/agents` had just been fixed
         * for, still sitting here.
         */}
        <div className="mt-[42px] w-full max-w-2xl">
          {/*
           * The heading is repeated in each arm rather than hoisted above this conditional:
           * `CarouselPrevious`/`CarouselNext` read the carousel's own context, so they must stay
           * inside `<Carousel>`, and the heading shares that row with them once populated. Each
           * arm also reserves the same ~180px of body beneath it — a skeleton here, the
           * carousel's 144×180 cards, or the empty/error state's own `h-[180px]` — so the section
           * holds its own height across all four states and the composer sitting above it on
           * this centred column does not move when the query settles or fails.
           */}
          {loading ? (
            <>
              <h2 className="font-bold text-[15px]">发现员工</h2>
              <Skeleton className="mt-4 h-[180px] rounded-[14px]" />
            </>
          ) : explore?.length ? (
            // Wins over `failed`: a failed background refetch does not clear TanStack Query's
            // cached `data`, so a stale carousel here beats an error card claiming there is
            // nothing to explore, which would be false while this list is still populated.
            <Carousel opts={{ align: "start" }}>
              <div className="flex flex-row items-center justify-between gap-4">
                <h2 className="font-bold text-[15px]">发现员工</h2>
                {/*
                 * `static` undoes the primitive's own absolute placement, which parks these either
                 * side of the row and off the edge of a prose-width column. They belong on the
                 * heading's baseline, where the section's other decisions are.
                 */}
                <div className="flex items-center gap-2">
                  <CarouselPrevious className="static translate-x-0 translate-y-0" />
                  <CarouselNext className="static translate-x-0 translate-y-0" />
                </div>
              </div>
              {/* `-ml-4`/`pl-4` is the primitive's own gap convention; `basis-auto` keeps each
                  slide the card's own 144px instead of a full-width slide. */}
              <CarouselContent className="-ml-4 mt-4">
                {explore.map((agent) => (
                  <CarouselItem className="basis-auto pl-4" key={agent.id}>
                    <Link search={{ agent: agent.id }} to="/channel/new">
                      <AgentCard agent={agent} appearance="artwork" />
                    </Link>
                  </CarouselItem>
                ))}
              </CarouselContent>
            </Carousel>
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
                className="mt-4 h-[180px] rounded-[14px] border border-signal/30 border-dashed bg-signal-soft"
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
                className="mt-4 h-[180px] min-h-0 rounded-[14px] border border-border border-dashed"
                description="同事把员工共享给你之后，会出现在这里。"
                mood="cute"
                title="还没有人把员工共享给你。"
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}
