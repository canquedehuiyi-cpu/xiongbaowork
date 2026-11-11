import {
  IconBook,
  IconChevronRight,
  IconPlus,
  IconStack2,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { BotRoster } from "@/components/bots/bot-roster";
import {
  LabeledSelect,
  type LabeledSelectOption,
} from "@/components/layout/labeled-select";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import { SearchBox } from "@/components/layout/search-box";
import {
  SegmentedTabs,
  tabPanelProps,
} from "@/components/layout/segmented-tabs";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { STATUS_WORD } from "@/components/wakers/coworker-card";
import { CreateCrewDialog, CrewTab } from "@/components/wakers/crews";
import {
  STATUS_ORDER,
  useRosterFacts,
} from "@/components/wakers/roster-facts";
import {
  isNarrowed,
  parseWakersSearch,
  rememberWakersSearch,
  type WakerEnv,
  type WakerSort,
  type WakersSearch,
  wallSearch,
} from "@/components/wakers/wakers-search";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useSearchDraft } from "@/lib/use-search-draft";

/**
 * 员工（`/bots`）：上游的员工列表页，熊宝的员工管理（原 `/wakers`）并进来了（M5b）。
 *
 * - 顶部「员工 | 群组」两个页签（`?tab=groups`）：员工页签是上游的分区名单（需要你、已置顶、你的员工、共享给你的、
 *   已隐藏），画的是熊宝员工墙的卡片；群组页签是熊宝的群组（`waker_groups`），每张卡链到看板和组团流程。
 * - 头部按钮：「角色模板」去能力 › 角色模板；「新建员工」打开熊宝向导（`?new=true`），建好去那位员工的页面。
 * - 工具栏：搜索、运行状态、角色、环境、排序四个筛选，加上卡片 / 列表两种画法。每一项都在地址里，所以刷新、分享
 *   的链接和员工详情页的返回链接都回到同一个筛好的名单。
 * - `?agent=<id>` 在名单上打开那位员工的编辑框（每张卡上的「编辑」）。
 */

/** The card's environment tag in the same words: 本地 = one of this person's machines. */
const ENV_OPTIONS: readonly LabeledSelectOption<"all" | WakerEnv>[] = [
  { value: "all", label: "全部环境" },
  { value: "device", label: "本地" },
  { value: "unbound", label: "未绑定" },
];

const SORT_OPTIONS: readonly LabeledSelectOption<"default" | WakerSort>[] = [
  { value: "default", label: "默认排序" },
  { value: "name", label: "按名称" },
  { value: "recent", label: "按最近运行" },
  { value: "tasks", label: "按任务数" },
];

/**
 * Each filter box as wide as its chosen value, as the reference draws 「运行状态 全部」 at 128px,
 * rather than as wide as its longest option (a native select's default). Browsers without
 * `field-sizing` fall back to the default.
 */
const FILTER = "[&_select]:field-sizing-content";

/** theme.css `.badge.accent`: the count at the right of the pill row. */
const COUNT_BADGE =
  "inline-flex h-[21px] items-center rounded-full bg-foreground/[0.085] px-[8px] font-semibold text-[11px] text-foreground tabular-nums whitespace-nowrap";

/** Just longer than a dialog's exit, so it has finished closing before the page changes. */
const DIALOG_CLOSE_MS = 240;

export function BotsPage({ search }: { search: WakersSearch }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const tab = search.tab === "groups" ? "groups" : "coworkers";
  const [query, setQuery] = useSearchDraft(search.q ?? "");
  const [creatingCrew, setCreatingCrew] = useState(false);
  const facts = useRosterFacts();
  const { agents, groups, running, attention, month, roster, counts, roles } =
    facts;

  useEffect(() => {
    rememberWakersSearch(search);
  }, [search]);

  /** One axis of the address; the others ride along. Undefined drops the key. */
  const patch = (over: Partial<WakersSearch>, replace = true) =>
    navigate({
      replace,
      search: parseWakersSearch({ ...search, ...over }),
      to: "/bots",
    });

  const narrowed = isNarrowed(search, query);
  /** How many the toolbar leaves standing, across every section, hidden ones included. */
  const visible = narrowed
    ? facts.narrow(roster, search, query).length
    : roster.length;

  /*
   * The two dialogs over the roster. Creating wins if both are set: it is the more recent intent.
   * Closing returns to the roster's own address, filters intact; a pushed entry, so Back reopens what
   * was just closed.
   */
  const wall = wallSearch(search);
  const showCreate = search.new === true;
  const showProfile = !showCreate && search.agent !== undefined;
  const closeDialog = () => void navigate({ search: wall, to: "/bots" });

  const clearFilters = () => {
    setQuery("");
    void patch({
      q: undefined,
      status: undefined,
      role: undefined,
      env: undefined,
    });
  };

  return (
    <PageShell
      action={
        tab === "coworkers" ? (
          <div
            className="flex flex-wrap gap-[7px]"
            data-testid="wakers-header-actions"
          >
            {/* Story ROLE1: the role templates new and existing coworkers are made from. */}
            <Button
              className="h-[34px] px-[11px] text-[13px]"
              render={(props) => <Link to="/capabilities/roles" {...props} />}
              variant="outline"
            >
              <IconStack2 aria-hidden="true" />
              角色模板
            </Button>
            {/* Spec D2: creating a coworker is a dialog over this roster, deep-linked. */}
            <Button
              className="h-[34px] px-[11px] text-[13px]"
              render={(props) => (
                <Link search={{ ...wall, new: true }} to="/bots" {...props} />
              )}
            >
              <IconPlus aria-hidden="true" />
              新建员工
            </Button>
          </div>
        ) : (
          <Button
            className="h-[34px] px-[11px] text-[13px]"
            onClick={() => setCreatingCrew(true)}
          >
            <IconPlus aria-hidden="true" />
            新建群组
          </Button>
        )
      }
      description={
        personal
          ? "你日常用的员工。"
          : "管理你的员工、群组，以及别人共享给你的员工。"
      }
      eyebrow="04 DIGITAL TEAM"
      title="员工"
      width="workbench"
    >
      {/*
        docs/design/ios-studio `.section-head` + `.controls`: the 员工 | 群组 pill with each side's
        count and, at the far right, how many are listed; the search, the four filters and the view
        under it; the roster under those.
      */}
      <div className="flex flex-col gap-[10px] pb-8">
        <div className="flex flex-wrap items-center justify-between gap-[10px]">
          <SegmentedTabs
            label="员工与群组"
            // A click is a step Back can return to; arrowing across the two is not.
            onValueChange={(next, change) =>
              void patch(
                { tab: next === "groups" ? "groups" : undefined },
                change.keyboard,
              )
            }
            panelId="wakers-wall"
            tabs={[
              // A count only once its read answered: 「0」 beside a pending roster would be a guess.
              {
                value: "coworkers",
                label: "员工",
                count: agents.data ? roster.length : undefined,
              },
              {
                value: "groups",
                label: "群组",
                count: groups.data ? groups.data.length : undefined,
              },
            ]}
            value={tab}
          />
          {/* An unread roster has no count: 「0 名员工」 beside a skeleton or an error would be a wrong answer. */}
          {tab === "coworkers" && agents.data ? (
            <span className={COUNT_BADGE} data-testid="waker-count">
              {narrowed
                ? `${visible} / ${roster.length} 名员工`
                : `${roster.length} 名员工`}
            </span>
          ) : null}
          {tab === "groups" && groups.data ? (
            <span className={COUNT_BADGE}>{groups.data.length} 个群组</span>
          ) : null}
        </div>

        <div
          {...tabPanelProps("wakers-wall", tab)}
          className="flex flex-col gap-[13px]"
        >
          {tab === "coworkers" ? (
            <>
              <div className="flex flex-wrap items-center gap-[6px]">
                <SearchBox
                  className="w-[221px] max-w-full"
                  label="搜索名称或角色"
                  onValueChange={(next) => {
                    setQuery(next);
                    void patch({ q: next || undefined });
                  }}
                  placeholder="搜索名称或角色..."
                  value={query}
                />
                <LabeledSelect
                  className={FILTER}
                  label="运行状态"
                  onValueChange={(next) =>
                    void patch({ status: next === "all" ? undefined : next })
                  }
                  options={[
                    // The total is the badge above; each state carries its own.
                    { value: "all", label: "全部" },
                    ...STATUS_ORDER.map((key) => ({
                      value: key,
                      label: `${STATUS_WORD[key]} (${counts[key]})`,
                    })),
                  ]}
                  value={search.status ?? "all"}
                />
                <LabeledSelect
                  className={FILTER}
                  label="角色"
                  onValueChange={(next) =>
                    void patch({ role: next === "\u0000" ? undefined : next })
                  }
                  options={[
                    // A role can be any text, so "all" is a value no title can be.
                    { value: "\u0000", label: "全部角色" },
                    ...(search.role && !roles.includes(search.role)
                      ? [search.role]
                      : []
                    )
                      .concat(roles)
                      .map((role) => ({ value: role, label: role })),
                  ]}
                  value={search.role ?? "\u0000"}
                />
                <LabeledSelect
                  className={FILTER}
                  label="环境"
                  onValueChange={(next) =>
                    void patch({ env: next === "all" ? undefined : next })
                  }
                  options={ENV_OPTIONS}
                  value={search.env ?? "all"}
                />
                <LabeledSelect
                  className={FILTER}
                  label="排序"
                  onValueChange={(next) =>
                    void patch({ sort: next === "default" ? undefined : next })
                  }
                  options={SORT_OPTIONS}
                  value={search.sort ?? "default"}
                />
                {narrowed ? (
                  <Button
                    className="h-[32px]"
                    onClick={clearFilters}
                    variant="ghost"
                  >
                    清除筛选
                  </Button>
                ) : null}
                {/* 卡片（熊宝的员工墙）或列表（上游的名单行），同一份名单两种画法。 */}
                <SegmentedTabs
                  className="ml-auto"
                  label="显示方式"
                  onValueChange={(next, change) =>
                    void patch(
                      { view: next === "list" ? "list" : undefined },
                      change.keyboard,
                    )
                  }
                  size="sm"
                  tabs={[
                    { value: "cards", label: "卡片" },
                    { value: "list", label: "列表" },
                  ]}
                  value={search.view === "list" ? "list" : "cards"}
                />
              </div>

              {running.isError ? (
                /*
                 * Said once, above everything, as well as on each card: without this line the cards
                 * below would read "nothing running" as fact when the board could not be read at all.
                 */
                <p className="text-destructive text-sm" role="alert">
                  看板读不到，所以下面显示的状态无法确认。
                </p>
              ) : null}
              {attention.isError ? (
                <p className="text-destructive text-sm" role="alert">
                  暂停状态读不到，所以下面的员工是否被暂停无法确认。
                </p>
              ) : null}
              {month.isError && !month.data ? (
                /*
                 * A side read: the roster is still right without it, so it is a status line with a
                 * way to ask again rather than an alert, and the cards say "—" instead of a zero never
                 * seen.
                 */
                <p
                  className="flex items-center gap-2 text-muted-foreground text-sm"
                  role="status"
                >
                  任务数和最近运行读不到（{month.error.message}
                  ），卡片上暂时显示为 —。
                  <Button
                    disabled={month.isFetching}
                    onClick={() => void month.refetch()}
                    size="xs"
                    variant="outline"
                  >
                    重新读取
                  </Button>
                </p>
              ) : null}

              <div>
                <BotRoster
                  onClearFilters={clearFilters}
                  query={query}
                  search={search}
                />
                {personal ? <WhatYourBotsKnow /> : null}
              </div>
            </>
          ) : groups.isError && !groups.data ? (
            <QueryError
              error={groups.error}
              label="读不到群组"
              onRetry={() => void groups.refetch()}
              retrying={groups.isFetching}
            />
          ) : (
            <CrewTab
              crews={groups.data ?? []}
              loading={groups.isPending}
              onCreate={() => setCreatingCrew(true)}
              queryClient={queryClient}
              roster={(agents.data ?? []).filter((agent) => !agent.hidden)}
              rosterLoading={agents.isPending}
            />
          )}
        </div>
      </div>
      <CreateCrewDialog
        onOpenChange={setCreatingCrew}
        open={creatingCrew}
        queryClient={queryClient}
      />
      {/*
        熊宝的新建向导（人设、模型库、头像、角色模板），并入了上游「独立运行」的开关。上游的 NewBotSheet
        （components/agents/new-bot-sheet.tsx）不再挂在这里，文件与测试留着方便以后同步上游。
      */}
      <CreateAgentDialog
        onClose={closeDialog}
        onCreated={(agentId) => {
          /*
           * Close first, then go: replacing the `?new` entry means Back from the new coworker lands
           * on the roster, not on an empty wizard.
           */
          void navigate({ replace: true, search: wall, to: "/bots" });
          window.setTimeout(
            () =>
              void navigate({
                params: { agentId },
                to: "/bots/$agentId",
              }),
            DIALOG_CLOSE_MS,
          );
        }}
        open={showCreate}
      />
      <AgentDialog
        agentId={search.agent ?? null}
        onClose={closeDialog}
        open={showProfile}
      />
    </PageShell>
  );
}

/**
 * Capabilities, in the personal edition, where it is not a page of its own: what a person's Bots
 * know how to do, beneath the Bots themselves. No Memory row: the personal edition has no memory
 * (see `offersMemory`).
 */
function WhatYourBotsKnow() {
  return (
    <PageSection className="mt-8" title="你的员工会什么">
      <PageRows>
        <Item render={<Link to="/capabilities/skills" />} size="sm">
          <ItemMedia variant="icon">
            <IconBook />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>技能</ItemTitle>
            <ItemDescription>你写的、或者员工自己学会的分步说明。</ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
