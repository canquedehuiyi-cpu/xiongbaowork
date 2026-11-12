import {
  IconBolt,
  IconChevronRight,
  IconPlus,
  IconShare,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ComponentProps, Fragment, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  waitingOnYou,
} from "@/components/bot-profile/attention";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import { WorkbenchEmpty } from "@/components/layout/workbench-empty";
import { NeedsYouBoard } from "@/components/needs-you/board";
import { DoneTasks, useNeedsYou } from "@/components/needs-you/needs-you";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { CARD_TAG, GRID, ordinal } from "@/components/wakers/card-chrome";
import {
  CoworkerCard,
  CreateCoworkerCard,
  STATUS_WORD,
} from "@/components/wakers/coworker-card";
import {
  type RosterFacts,
  useRosterFacts,
} from "@/components/wakers/roster-facts";
import {
  isNarrowed,
  type WakersSearch,
  wallSearch,
} from "@/components/wakers/wakers-search";
import type { AgentProfile } from "@/lib/agents/queries";
import { groupRoster } from "@/lib/agents/roster";
import { setBotPausedMutationOptions } from "@/lib/bot-lifecycle/mutations";
import { shortName } from "@/lib/brand";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/**
 * Every Bot the person can reach, in the one place they are listed: what needs the person first,
 * then pinned, then their own, then the ones shared with them, and the ones they hid folded away at
 * the end.
 *
 * Needs you is where the sidebar's badge leads, so it holds everything behind that number in one
 * card: the Bots with a question, an approval or a stalled hand-off (answered on the Bot's page),
 * the tasks started from check-ins, and what every Bot's check-ins found, each row naming its Bot.
 *
 * This replaces three screens (Bots, Agents and Team Bots) that listed the same Bots three ways.
 *
 * 熊宝（M5b）：上游的分区里画的是熊宝员工墙的内容——每位员工的状态（在线 / 休息 / 暂停 / 状态未知）、设备环境、
 * 本月任务数与最近运行、群组、个人分身标记（分身固定在「你的员工」第一位）。员工页工具栏的搜索、筛选、排序对每个
 * 分区都生效；`view` 决定画成卡片（默认）还是列表。原「团队 Bot」页里「你可以用的」就是「共享给你的」这一节，
 * 发布与分配在每位员工的「共享」分页。
 */
export function BotRoster({
  search = {},
  query = "",
  onClearFilters,
}: {
  /** The roster's address: the filters, the sort and the view. */
  search?: WakersSearch;
  /** The search box's live text, ahead of the address while typing. */
  query?: string;
  onClearFilters?: () => void;
}) {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const facts = useRosterFacts();
  const list = useNeedsYou();
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const view = search.view === "list" ? "list" : "cards";
  const narrowed = isNarrowed(search, query);
  const roster = wallSearch(search);
  const createSearch: WakersSearch = { ...roster, new: true };
  const { agents } = facts;

  // Only when nothing ever loaded: a failed background refetch keeps the roster it had.
  if (agents.data === undefined && agents.isError) {
    return (
      <QueryError
        error={agents.error}
        label="读不到员工"
        onRetry={() => void agents.refetch()}
        retrying={agents.isFetching}
      />
    );
  }
  if (agents.data === undefined) {
    return (
      <div className={GRID} data-testid="waker-skeleton">
        {[0, 1, 2].map((key) => (
          <Skeleton className="h-[177px] rounded-[16px]" key={key} />
        ))}
      </div>
    );
  }
  if (facts.roster.length === 0) {
    return (
      <div className={EMPTY_FRAME} data-testid="wakers-empty">
        <WorkbenchEmpty
          action={
            <Button
              className="h-[29px] text-[12px]"
              render={(props) => (
                <Link search={createSearch} to="/bots" {...props} />
              )}
            >
              <IconPlus aria-hidden="true" />
              新建员工
            </Button>
          }
          description="新建一位员工，或者从角色模板开始。"
          mood="sweet"
          title="这里还没有员工"
        />
      </div>
    );
  }

  // Every Bot stays in its own section; what it waits on is on the board above, by name.
  const groups = groupRoster(agents.data, undefined, facts.avatarAgentId);
  const shown = (agentsIn: readonly AgentProfile[]) =>
    facts.order(facts.narrow(agentsIn, search, query), search.sort);
  const pinned = shown(groups.pinned);
  const yours = shown(groups.yours);
  const shared = shown(groups.shared);
  const hidden = shown(facts.hidden.data ?? []);
  const yoursPinned =
    groups.yours.length === 0 && groups.pinned.some((agent) => agent.mine);

  if (
    narrowed &&
    pinned.length + yours.length + shared.length + hidden.length === 0
  ) {
    return (
      <div className={EMPTY_FRAME} data-testid="wakers-no-match">
        <WorkbenchEmpty
          action={
            onClearFilters ? (
              <Button
                className="h-[29px] text-[12px]"
                onClick={onClearFilters}
                variant="outline"
              >
                清除筛选
              </Button>
            ) : undefined
          }
          description="换个关键词，或者清除筛选看全部员工。"
          mood="cute"
          title="没有符合这个筛选条件的员工。"
        />
      </div>
    );
  }

  /*
   * Numbered in the order drawn, across the sections, as the reference numbers its profiles
   * (`PROFILE / 01`). A folded 已隐藏 section draws nothing, so it takes no numbers.
   */
  let position = 0;
  const draw = (section: string, agentsIn: AgentProfile[], create = false) => {
    const start = position;
    position += agentsIn.length;
    return view === "list" ? (
      <RosterRows agents={agentsIn} facts={facts} />
    ) : (
      <div
        className={cn(GRID, "mt-4")}
        data-section={section}
        data-testid="waker-grid"
      >
        {agentsIn.map((agent, index) => (
          <PausableCard
            agent={agent}
            attention={facts.attentionById.get(agent.id)}
            crews={facts.crewsOf(agent)}
            device={facts.deviceLineOf(agent)}
            editSearch={{ ...roster, agent: agent.id }}
            index={ordinal(start + index)}
            isAvatar={agent.id === facts.avatarAgentId}
            key={agent.id}
            pauseKnown={facts.pausedIds !== null}
            pauseUnreadable={facts.attention.isError}
            stats={facts.statsOf(agent)}
            status={facts.statusOf(agent)}
            unconfigured={agent.id === facts.unconfiguredAvatar}
          />
        ))}
        {/* After the last of 你的员工: one more slot, the way to add one. */}
        {create ? <CreateCoworkerCard search={createSearch} /> : null}
      </div>
    );
  };

  const hiddenShown = hiddenOpen || narrowed;

  return (
    <>
      {/*
       * What waits on the person, each thing under the Bot it came from and decided where it is.
       * A Bot waiting on them stays in its own section below too, with its badge.
       */}
      <NeedsYouBoard />
      {pinned.length ? (
        <PageSection className={SECTION} title="已置顶">
          {draw("pinned", pinned)}
        </PageSection>
      ) : null}
      {yours.length || !narrowed ? (
        <PageSection className={SECTION} title="你的员工">
          {yours.length ? (
            draw("yours", yours, true)
          ) : (
            <PageEmpty
              action={
                yoursPinned ? undefined : (
                  <Button
                    render={(props) => (
                      <Link {...props} search={createSearch} to="/bots" />
                    )}
                    size="sm"
                    variant="outline"
                  >
                    <IconPlus />
                    新建员工
                  </Button>
                )
              }
              icon={IconBolt}
              title={yoursPinned ? "都已置顶" : "还没有你的员工"}
            >
              {yoursPinned
                ? "你的员工都已置顶在上面。"
                : "你新建的员工会出现在这里。"}
            </PageEmpty>
          )}
        </PageSection>
      ) : null}
      {shared.length || (!narrowed && !personal) ? (
        <PageSection
          className={SECTION}
          description={
            personal
              ? undefined
              : "同事发布给你、或公开给所有人的员工。你和它的每段对话只属于你，它的主人看不到。"
          }
          title={personal ? `${shortName()}自带的员工` : "共享给你的"}
        >
          {shared.length ? (
            draw("shared", shared)
          ) : (
            <PageEmpty icon={IconShare} title="还没有人共享员工给你">
              别人共享给你的员工会出现在这里。
            </PageEmpty>
          )}
        </PageSection>
      ) : null}
      <DoneTasks done={list.done} />
      {hidden.length ? (
        /*
         * The Bots this person hid, folded until asked for: a way back for somebody who hid
         * something, not a fourth list everybody reads past. A Bot's page is where Unhide lives. The
         * personal edition has nobody else with a list, so it doesn't say only theirs changed. A
         * filter that matches one opens it, so a narrowed roster never hides its own answer.
         */
        <PageSection
          action={
            narrowed ? undefined : (
              <Button
                onClick={() => setHiddenOpen(!hiddenOpen)}
                size="sm"
                variant="ghost"
              >
                {hiddenOpen ? "收起" : "显示"}
              </Button>
            )
          }
          className={SECTION}
          description={`你隐藏了 ${hidden.length} 位员工。${personal ? "" : "只改你自己的列表。"}`}
          title="已隐藏"
        >
          {hiddenShown ? draw("hidden", hidden) : null}
        </PageSection>
      ) : null}
    </>
  );
}

/** Sections sit closer than a settings page's: the roster is one list cut in parts, not a form. */
const SECTION = "mt-8";

/** The frame an empty or no-match answer sits in: the card surface, so the page keeps its shape. */
const EMPTY_FRAME =
  "rounded-[16px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]";

/** A card plus its own pause/resume write, so one card's failure is said on that card, by name. */
function PausableCard(
  card: Omit<
    ComponentProps<typeof CoworkerCard>,
    "busy" | "onTogglePause" | "problem"
  >,
) {
  const queryClient = useQueryClient();
  const lifecycle = useMutation(setBotPausedMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);
  const paused = card.status === "paused";
  const { agent } = card;
  return (
    <CoworkerCard
      {...card}
      busy={lifecycle.isPending}
      onTogglePause={() => {
        setProblem(null);
        lifecycle.mutate(
          { agentId: agent.id, paused: !paused },
          {
            // The server's own reason, after a sentence that says which card failed: the shared
            // fallback names no coworker.
            onError: (thrown: Error) =>
              setProblem(
                `没能${paused ? "恢复" : "暂停"}「${agent.name}」：${thrown.message}`,
              ),
          },
        );
      }}
      problem={problem}
    />
  );
}

function RosterRows({
  agents,
  facts,
}: {
  agents: AgentProfile[];
  facts: RosterFacts;
}) {
  return (
    <PageRows>
      {agents.map((agent, index) => (
        <Fragment key={agent.id}>
          {index > 0 ? <Separator /> : null}
          <RosterRow agent={agent} facts={facts} />
        </Fragment>
      ))}
    </PageRows>
  );
}

/**
 * One Bot as a row, opening its page: its state and where it runs, its month on the board, and what
 * from it waits on the person. The count is everything from it that waits on the person, its
 * check-in items and tasks included, so a Bot whose items are listed under 需要你 still says so
 * wherever it sits.
 */
function RosterRow({
  agent,
  facts,
}: {
  agent: AgentProfile;
  facts: RosterFacts;
}) {
  const state = facts.attentionById.get(agent.id);
  const status = facts.statusOf(agent);
  const stats = facts.statsOf(agent);
  const isAvatar = agent.id === facts.avatarAgentId;
  const waiting = state ? waitingOnYou(state) : 0;
  const asks = state ? attentionSummary(state) : "";
  const line: string[] = [
    STATUS_WORD[status],
    facts.deviceLineOf(agent) ? "本地" : "未绑定",
    `任务数 ${stats ? `${stats.truncated ? "≥" : ""}${stats.stats.count}` : "—"}`,
    `最近运行 ${stats?.stats.lastRunAt ? relativeTime(stats.stats.lastRunAt) : "—"}`,
  ];
  return (
    <Item
      data-testid="waker-row"
      render={<Link params={{ agentId: agent.id }} to="/bots/$agentId" />}
      size="sm"
    >
      <ItemMedia>
        <AbstractAvatar
          name={agent.name}
          portrait={{ kind: "coworker", id: agent.id }}
          seed={agent.avatarSeed}
          size={28}
        />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {agent.name}
          {isAvatar ? <span className={CARD_TAG}>个人分身</span> : null}
          {agent.id === facts.unconfiguredAvatar ? (
            <span
              className={cn(
                CARD_TAG,
                "border-signal/45 border-dashed text-signal-ink",
              )}
            >
              待配置
            </span>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          <span data-status={status}>{line.join(" · ")}</span>
          {asks ? (
            <>
              {" · "}
              <span>{asks}</span>
            </>
          ) : agent.title.trim() && !isAvatar ? (
            ` · ${agent.title.trim()}`
          ) : null}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {waiting > 0 ? (
          <span className="rounded-full bg-primary px-1.5 font-medium text-[11px] text-primary-foreground tabular-nums">
            {waiting}
          </span>
        ) : null}
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}
