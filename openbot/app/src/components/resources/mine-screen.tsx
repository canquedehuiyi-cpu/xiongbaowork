import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  connectsPerPerson,
  textMatch,
} from "@/components/resources/capability-tabs";
import {
  RunnableBadge,
  runnableGrade,
} from "@/components/resources/runnable-badge";
import {
  ConnectorCard,
  type ConnectorState,
} from "@/components/resources/connector-card";
import { TeamCard } from "@/components/resources/team-card";
import {
  CardGrid,
  NoMatch,
  QueryState,
  SectionHead,
  TabEmpty,
  TabHeader,
  TabSearch,
} from "@/components/resources/resource-kit";
import { Button } from "@/components/ui/button";
import {
  appKeyOf,
  connectionsQueryOptions,
  personalConnections,
  pluginsPageQueryOptions,
  type PluginServer,
} from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/**
 * 「我的」（`/capabilities/mine`，P4）：一个员工被给了什么的单一列表。
 *
 * 三块共用一次 `/api/plugins` 读，所以失败是这一页自己的告警——技能（每条带移植档位徽章）、
 * 团队（4b：`kind: "team"` 的频道行，品牌包给的专家团）和连接器。团队块对不下发该字段的老服务端
 * 退回空态，不崩。
 *
 * 技能块在 4c 之前是一个平铺长列表：品牌包给 109 条，其中 36 条暂不可用、11 条部分可用，
 * 「我能用什么」要滚到底才数得出来。所以档位数先答数、点一下按档位收窄，搜索按标题/说明/理由
 * 收窄；两者都只过滤这一份已读到的数据，不另发请求。
 *
 * 连接器块在 4d 之前只看 `hasCredential`——那是「部署手里有没有这一份凭据」。以本人身份访问的
 * 应用不是这样：凭据在每个人自己身上，于是已连上的人照样被画「待绑定」、照样被叫去连接。现在
 * 这类应用多读一次 `/api/plugins/connections`，读不到就说读不到，绝不替人断言没连。
 *
 * 团队块的卡片带一条进去的入口（`/channel/$channelId`，多员工的团由那条路由转给群聊）：这一页是
 * 「我被给了什么」的清单，列表里的每一样都该能从这里走到去用它。
 */

/**
 * 一个收窄按钮：文案加条数就是它的可访问名字（`暂不可用 36`、`只看待连接的 1`），所以读屏念出来
 * 与眼睛看到的一致，`aria-pressed` 说它当前是不是筛子。技能按档位用它，连接器按「要不要你去连」
 * 也用它——两处的「一共多少、筛完多少」是同一个问题。
 */
function GradeChip({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "inline-flex h-[26px] items-center gap-[5px] rounded-full border px-[10px] text-[11px] leading-[16px] transition-colors",
        active
          ? "border-foreground/25 bg-foreground/[0.06] font-semibold text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {label}
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

type GradeFilter = "all" | "full" | "degraded" | "blocked" | "unevaluated";

const GRADE_CHIPS: { key: Exclude<GradeFilter, "all">; label: string }[] = [
  { key: "full", label: "完整可用" },
  { key: "degraded", label: "部分可用" },
  { key: "blocked", label: "暂不可用" },
];

/**
 * 卡片上的理由写到多长就不再展开：两句正文加一条引文大约两行。这是对**服务端给的那串文字**的
 * 长度判断，不是量版面——测试环境没有排版，量不出来也就守不住。
 */
const REASON_FOLD = 60;

/**
 * 一批画多少张：三列网格下正好十行。109 条的包先给三十条，剩下多少由网格下面那行字回答——
 * 档位汇总答的是「我能用什么」，一批一批地给答的是「还有什么」。
 */
const BATCH = 30;

export function MineScreen() {
  const page = useQuery(pluginsPageQueryOptions());

  const skills = page.data?.skills ?? [];
  const teams = page.data?.teams ?? [];
  const servers = page.data?.servers ?? [];

  /*
   * 第二个读，只为回答「这个人自己连上没有」。没有连接器可画时不发这个请求。
   */
  const connections = useQuery({
    ...connectionsQueryOptions(),
    enabled: servers.length > 0,
  });

  const [grade, setGrade] = useState<GradeFilter>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(BATCH);
  const [onlyPending, setOnlyPending] = useState(false);
  const [openReasons, setOpenReasons] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const counts = { full: 0, degraded: 0, blocked: 0, unevaluated: 0 };
  for (const skill of skills) {
    const value = runnableGrade(skill.runnable);
    if (value) counts[value] += 1;
    else counts.unevaluated += 1;
  }

  const visible = skills.filter((skill) => {
    const value = runnableGrade(skill.runnable);
    const sameGrade =
      grade === "all"
        ? true
        : grade === "unevaluated"
          ? value === undefined
          : value === grade;
    if (!sameGrade) return false;
    return textMatch(
      query,
      skill.title,
      skill.summary,
      skill.blockedReasonRef,
      skill.blockedReason,
    );
  });

  /*
   * 一批一批地给：`shown` 是这一轮已经画出来的条数，换筛选或搜索词就回到第一批——否则
   * 「还有几条没显示」说的是上一组的数。
   */
  const batch = visible.slice(0, shown);
  const hidden = visible.length - shown;

  const clearFilters = () => {
    setGrade("all");
    setQuery("");
    setShown(BATCH);
  };

  const toggleReason = (slug: string) => {
    setOpenReasons((open) => {
      const next = new Set(open);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  /** 点已选中的那一档就放开筛选，而不是把人困在一种收窄里。 */
  const pickGrade = (key: GradeFilter) => {
    setGrade((current) => (current === key ? "all" : key));
    setShown(BATCH);
  };

  /** 换搜索词等于换一组结果，从第一批数起。 */
  const search = (value: string) => {
    setQuery(value);
    setShown(BATCH);
  };

  /*
   * 一个连接器站在哪儿，三条判据按顺序：
   * - 清单说 `builtin`/`none` 的（品牌包的 `team:staffing`），本身就没有凭据可放，没有凭据不是
   *   缺什么；
   * - 以本人身份访问的（清单里的 `user-oauth`、broker 上要账号的那些）要读这个人自己的连接，
   *   读不到就说读不到——猜成「没连」会让人去连一个已经连上的账号；
   * - 其余看部署手里那份凭据。
   */
  const mine = new Set(
    personalConnections(connections.data?.connections ?? []).map(
      (row) => row.serverId,
    ),
  );

  const connectorState = (server: PluginServer): ConnectorState => {
    const listed = page.data?.catalogue.find(
      (entry) => entry.key === appKeyOf(server),
    );
    if (listed?.auth === "builtin" || listed?.auth === "none") return "settled";
    if (page.data && connectsPerPerson(server, page.data)) {
      if (connections.isPending) return "loading";
      if (connections.error) return "unreadable";
      return mine.has(server.id) ? "settled" : "pending";
    }
    return server.hasCredential ? "settled" : "pending";
  };

  /*
   * 连接器块的筛子：一屏连接器里往往只有一两个是待办，要找出它们得先认一遍徽章。挑的条件就是上面
   * 算好的状态，不另发请求。
   *
   * 只有「一部分要连、一部分不用」时才画这个开关：全都连好没什么可挑，全都待连接也无从挑，两种
   * 情况下筛了跟没筛一样，画出来就是一个按了什么都不变的按钮。开关没了，筛选也不再作用——一张
   * 管不住自己的清单比没有清单更糟。
   */
  const connectors = servers.map((server) => ({
    server,
    state: connectorState(server),
  }));
  const pendingConnectors = connectors.filter((row) => row.state === "pending");
  const canPickPending =
    pendingConnectors.length > 0 &&
    pendingConnectors.length < connectors.length;
  const shownConnectors =
    onlyPending && canPickPending ? pendingConnectors : connectors;

  return (
    <div className="px-1 pb-6">
      <TabHeader
        description="这个员工被给了什么：技能、团队、连接器。技能的档位是移植时逐条审出来的——完整可用能照正文干，部分可用缺了引用的文件，暂不可用缺的是运行环境或授权。"
        search={
          skills.length > 0 ? (
            <TabSearch label="搜索技能" onChange={search} value={query} />
          ) : undefined
        }
      />

      <section aria-labelledby="mine-skills-head" className="mt-[16px]">
        <SectionHead
          aside={
            skills.length > 0 ? (
              <fieldset
                aria-label="按档位筛选"
                className="m-0 flex min-w-0 flex-wrap items-center gap-[6px] border-0 p-0"
              >
                <GradeChip
                  active={grade === "all"}
                  count={skills.length}
                  label="全部"
                  onClick={() => {
                    setGrade("all");
                    setShown(BATCH);
                  }}
                />
                {GRADE_CHIPS.map((chip) => (
                  <GradeChip
                    active={grade === chip.key}
                    count={counts[chip.key]}
                    key={chip.key}
                    label={chip.label}
                    onClick={() => pickGrade(chip.key)}
                  />
                ))}
                {counts.unevaluated > 0 ? (
                  <GradeChip
                    active={grade === "unevaluated"}
                    count={counts.unevaluated}
                    label="未评估"
                    onClick={() => pickGrade("unevaluated")}
                  />
                ) : null}
              </fieldset>
            ) : undefined
          }
          id="mine-skills-head"
          title="技能"
        />
        <QueryState label="读不到你的技能" query={page}>
          {skills.length === 0 ? (
            <TabEmpty
              description="管理员或品牌包把技能给你的员工后，这里会一条条列出来。"
              title="还没有被给的技能"
            />
          ) : visible.length === 0 ? (
            <NoMatch onClear={clearFilters} title="没有匹配的技能" />
          ) : (
            <>
              <CardGrid className="mt-[9px]" label="被给的技能">
                {batch.map((skill) => {
                  const reason = skill.blockedReasonRef ?? skill.blockedReason;
                  const expanded = openReasons.has(skill.slug);
                  return (
                    <li
                      className="rounded-[13px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] px-[13px] py-[11px]"
                      key={skill.slug}
                    >
                      <div className="flex items-start justify-between gap-[9px]">
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium">
                            {skill.title}
                          </p>
                          <p className="mt-[3px] line-clamp-2 text-[11px] text-muted-foreground">
                            {skill.summary}
                          </p>
                        </div>
                        <RunnableBadge runnable={skill.runnable} />
                      </div>
                      {/*
                      R18：badged-but-unexplained 是 bug 不是状态。徽章打了非 full 就必须答
                      「缺什么」——引文给人读（规则理由 ← 最强命中），规则 id 挂 title 供检索。
                      两行放不下的理由就地展开：截断等于答一半。
                    */}
                      {skill.runnable && skill.runnable !== "full" && reason ? (
                        <div className="mt-[6px]">
                          <p
                            className={cn(
                              "text-[11px] text-muted-foreground",
                              expanded ? null : "line-clamp-2",
                            )}
                            title={skill.blockedReason ?? undefined}
                          >
                            {reason}
                          </p>
                          {reason.length > REASON_FOLD ? (
                            <button
                              aria-expanded={expanded}
                              className="mt-[3px] text-[11px] text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
                              onClick={() => toggleReason(skill.slug)}
                              type="button"
                            >
                              {expanded ? "收起原因" : "展开原因"}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </CardGrid>
              {/*
                一批画完还没到底就说清楚还剩多少：截图看不出一页之外还有东西，所以数字要写出来，
                按钮的名字里带条数，读屏念出来与眼睛看到的一致。
              */}
              {hidden > 0 ? (
                <div className="mt-[10px] flex flex-wrap items-center justify-between gap-[10px]">
                  <p className="text-[11px] text-muted-foreground">
                    已显示 {batch.length} / {visible.length}
                  </p>
                  <Button
                    onClick={() => setShown((count) => count + BATCH)}
                    size="sm"
                    variant="outline"
                  >
                    展开其余 {hidden} 条
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </QueryState>
      </section>

      <section aria-labelledby="mine-teams-head" className="mt-[16px]">
        <SectionHead id="mine-teams-head" title="团队" />
        <QueryState label="读不到你的团队" query={page}>
          {teams.length === 0 ? (
            <TabEmpty
              description="品牌包把专家团给你后，这里会一支支列出来；团队对话在侧栏里。"
              title="还没有被给的团队"
            />
          ) : (
            <CardGrid className="mt-[9px]" label="被给的团队">
              {teams.map((team) => (
                <TeamCard key={team.id} team={team} />
              ))}
            </CardGrid>
          )}
        </QueryState>
      </section>

      <section aria-labelledby="mine-connectors-head" className="mt-[16px]">
        <SectionHead
          aside={
            canPickPending ? (
              <GradeChip
                active={onlyPending}
                count={pendingConnectors.length}
                label="只看待连接的"
                onClick={() => setOnlyPending((on) => !on)}
              />
            ) : undefined
          }
          id="mine-connectors-head"
          title="连接器"
        />
        <QueryState label="读不到你的连接器" query={page}>
          {servers.length === 0 ? (
            <TabEmpty
              description="品牌包或管理员把连接器加进部署后，这里会一个个列出来。"
              title="还没有被给的连接器"
            />
          ) : (
            <CardGrid className="mt-[9px]" label="被给的连接器">
              {shownConnectors.map(({ server, state }) => (
                <ConnectorCard
                  action={
                    state === "pending" ? (
                      <Link
                        className="text-[11px] text-muted-foreground hover:text-foreground"
                        to="/connections"
                      >
                        去连接
                      </Link>
                    ) : undefined
                  }
                  key={server.id}
                  server={server}
                  state={state}
                />
              ))}
            </CardGrid>
          )}
        </QueryState>
      </section>
    </div>
  );
}
