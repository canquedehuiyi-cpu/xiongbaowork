import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  connectsPerPerson,
  textMatch,
} from "@/components/resources/capability-tabs";
import {
  ConnectorCard,
  type ConnectorState,
} from "@/components/resources/connector-card";
import {
  CardGrid,
  NoMatch,
  QueryState,
  SectionHead,
  TabEmpty,
  TabHeader,
  TabSearch,
} from "@/components/resources/resource-kit";
import {
  RunnableBadge,
  runnableGrade,
} from "@/components/resources/runnable-badge";
import { TeamCard } from "@/components/resources/team-card";
import { SkillViewLink } from "@/components/skills/skill-view";
import { Button } from "@/components/ui/button";
import {
  appKeyOf,
  connectionsQueryOptions,
  type PluginServer,
  personalConnections,
  pluginsPageQueryOptions,
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
 * 搜索框原先是「搜索技能」，只收窄三块里的一块。人打的字其实是在问「这个部署里有没有和 X 有关的
 * 东西」，答案不该只在一个块里，所以现在三块一起收窄。一块被搜索筛空时说自己那句「没有匹配的」，
 * 不说「还没有被给的」——那个团还在，只是不叫这个名字，说成没被给会把人支去找管理员要。
 *
 * 连接器块在 4d 之前只看 `hasCredential`——那是「部署手里有没有这一份凭据」。以本人身份访问的
 * 应用不是这样：凭据在每个人自己身上，于是已连上的人照样被画「待绑定」、照样被叫去连接。现在
 * 这类应用多读一次 `/api/plugins/connections`，读不到就说读不到，绝不替人断言没连。
 *
 * 团队块的卡片带一条进去的入口（`/channel/$channelId`，多员工的团由那条路由转给群聊）：这一页是
 * 「我被给了什么」的清单，列表里的每一样都该能从这里走到去用它。
 *
 * 页首那一行原先只是把三块念一遍，念完还是得自己滚：109 条技能铺满第一屏，团队和连接器在三十张卡
 * 之外，三块里只有一块够得到。现在每一样都是它那一块的锚点（`#mine-teams`、`#mine-connectors`），
 * 点一下落过去、焦点也交过去——否则跳完按 Tab 还留在页首。同一行仍是一句话，读屏听的是三个链接
 * 而不是三段被拆散的碎片。
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

/**
 * 三块各自的锚点 id。section 用它接住页首那一行的跳转，`SectionHead` 用 `<id>-head` 接
 * `aria-labelledby`——两件事，两个 id。
 */
const SKILLS_ID = "mine-skills";
const TEAMS_ID = "mine-teams";
const CONNECTORS_ID = "mine-connectors";

/** 落到哪一块之后那块亮多久：够看见，不够等到让人以为它一直在那儿。 */
const LIT_MS = 1200;

/**
 * 一块亮了就描一圈。描边是 `ring`（不占位置），所以亮与不亮之间版面不动——否则跳过去的一瞬间
 * 整块会挪一下，人刚被送到这里就被推走。
 */
const LIT_RING =
  "ring-1 ring-foreground/15 ring-offset-4 ring-offset-background";

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

  /*
   * 页首那一行点下去落在哪一块。浏览器自己会把 `#mine-teams` 滚到位，但它不会把焦点交出去：键盘
   * 用户跳过去之后按 Tab 还是从页首那个链接接着走。所以这里补上半步——滚到位，再把焦点放到那块
   * 上（section 带 `tabIndex={-1}` 就为这一刻）。
   *
   * 焦点落在一块内容上本来是看不见的（下面把默认那个大框关掉了），所以落过去之后让那块亮一下再
   * 熄掉：人是被一句话送到这里的，得知道落的是哪一截。人才市场的「去人才市场」用同一个做法。
   *
   * 走两条路是因为「地址变了」不等于「人要跳」：带 `#` 进来与第一次点，地址变了；滚回页首再点同一
   * 个入口，地址一模一样，可人是真的点了。所以点击自己也走一遍，不能只等地址。
   */
  const hash = useLocation({ select: (location) => location.hash });
  const [lit, setLit] = useState<string | null>(null);
  const litTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpTo = useCallback((id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView?.({ block: "start" });
    target.focus({ preventScroll: true });
    setLit(id);
    if (litTimer.current) clearTimeout(litTimer.current);
    litTimer.current = setTimeout(() => setLit(null), LIT_MS);
  }, []);
  useEffect(() => {
    const id = hash.replace(/^#/, "");
    if (id) jumpTo(id);
    return () => {
      if (litTimer.current) clearTimeout(litTimer.current);
    };
  }, [hash, jumpTo]);

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
   * 团队跟着同一个搜索词收窄。名字和说明都算：一个团的说明往往就是「它干什么」，找人找的常常正是
   * 这件事。
   */
  const visibleTeams = teams.filter((team) =>
    textMatch(query, team.name, team.description),
  );

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
    /*
     * 连接器的「只看待连接的」也一起放开。这个是这一页的取消键，不是某个块自己的：三块各有各的
     * 收窄（档位、要不要你去连、搜索词），只清一半就是把人留在另一个空列表里。
     */
    setOnlyPending(false);
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

  /*
   * 搜索也收窄这一块。挑出来的开关按搜索后的那一份算——否则搜索只剩一个已经连好的应用时，开关还
   * 写着「1 个待连接」，点下去一张卡都没有。
   */
  const searchedConnectors = connectors.filter(({ server }) =>
    textMatch(query, server.title, server.vendor, server.summary),
  );
  const blockPending = searchedConnectors.filter(
    (row) => row.state === "pending",
  );
  const canPickPending =
    blockPending.length > 0 && blockPending.length < searchedConnectors.length;
  const shownConnectors =
    onlyPending && canPickPending ? blockPending : searchedConnectors;

  /*
   * 三块规模的单行答案。这一页是「我被给了什么」，但一共几样得滚过三段才数得出来：技能块自己带了
   * 档位汇总，团队和连接器各多少却只有到那儿才知道。
   *
   * 只说有的那几样：「0 支团队」是三块的空态已经在回答的事，再说一遍是噪音。待连接的数只在每个连接器
   * 都答得上来时才写——有一次读不到，写「0 个待连接」就是替人断言没连，那正是 4d 修掉的那个错。
   *
   * 每一样都是它那一块的入口：技能一多，团队和连接器就在三十张卡下面，而这一行是整页唯一同时提到
   * 三块的地方。没被给的那块没有入口——点下去只会落在「还没有被给的」上。
   */
  const pendingCount =
    connectors.length > 0 &&
    connectors.every(
      (row) => row.state === "settled" || row.state === "pending",
    )
      ? pendingConnectors.length
      : null;
  const overview: { label: string; note?: string; target: string }[] = [];
  if (skills.length > 0) {
    overview.push({ label: `${skills.length} 条技能`, target: SKILLS_ID });
  }
  if (teams.length > 0) {
    overview.push({ label: `${teams.length} 支团队`, target: TEAMS_ID });
  }
  if (servers.length > 0) {
    overview.push({
      label: `${servers.length} 个连接器`,
      note: pendingCount ? `（${pendingCount} 个待连接）` : undefined,
      target: CONNECTORS_ID,
    });
  }

  return (
    <div className="px-1 pb-6">
      <TabHeader
        description="这个员工被给了什么：技能、团队、连接器。技能的档位是移植时逐条审出来的——完整可用能照正文干，部分可用缺了引用的文件，暂不可用缺的是运行环境或授权。"
        search={
          skills.length + teams.length + servers.length > 0 ? (
            <TabSearch
              label="搜索技能、团队和连接器"
              onChange={search}
              value={query}
            />
          ) : undefined
        }
      />

      {overview.length > 0 ? (
        <nav
          aria-label="跳到这一页的各块"
          className="mt-[14px] text-[12px] text-muted-foreground"
        >
          {overview.map((entry, index) => (
            <Fragment key={entry.target}>
              {index > 0 ? " · " : null}
              <a
                className="underline-offset-2 hover:text-foreground hover:underline"
                href={`#${entry.target}`}
                onClick={() => jumpTo(entry.target)}
              >
                {entry.label}
              </a>
              {entry.note}
            </Fragment>
          ))}
        </nav>
      ) : null}

      <section
        aria-labelledby="mine-skills-head"
        className={cn(
          "mt-[16px] scroll-mt-[12px] rounded-[13px] outline-none transition-shadow",
          lit === SKILLS_ID && LIT_RING,
        )}
        data-lit={lit === SKILLS_ID ? "true" : undefined}
        id={SKILLS_ID}
        tabIndex={-1}
      >
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
                        <div className="flex shrink-0 flex-col items-end gap-[5px]">
                          <RunnableBadge runnable={skill.runnable} />
                          {/*
                          卡片说得清「这条技能能干什么」，说不清「它教员工做什么」——正文在别处，
                          而那一处只有一个读得开（技能页的编辑面板只对自己的技能开）。有正文就给
                          一条路过去，没有正文的技能不画：那个地址打开只会说「没有正文」。
                        */}
                          {skill.instructions.trim() ? (
                            <SkillViewLink
                              slug={skill.slug}
                              title={skill.title}
                            />
                          ) : null}
                        </div>
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

      <section
        aria-labelledby="mine-teams-head"
        className={cn(
          "mt-[16px] scroll-mt-[12px] rounded-[13px] outline-none transition-shadow",
          lit === TEAMS_ID && LIT_RING,
        )}
        data-lit={lit === TEAMS_ID ? "true" : undefined}
        id={TEAMS_ID}
        tabIndex={-1}
      >
        <SectionHead id="mine-teams-head" title="团队" />
        <QueryState label="读不到你的团队" query={page}>
          {teams.length === 0 ? (
            <TabEmpty
              description="品牌包把专家团给你后，这里会一支支列出来；团队对话在侧栏里。"
              title="还没有被给的团队"
            />
          ) : visibleTeams.length === 0 ? (
            <NoMatch onClear={clearFilters} title="没有匹配的团队" />
          ) : (
            <CardGrid className="mt-[9px]" label="被给的团队">
              {visibleTeams.map((team) => (
                <TeamCard key={team.id} team={team} />
              ))}
            </CardGrid>
          )}
        </QueryState>
      </section>

      <section
        aria-labelledby="mine-connectors-head"
        className={cn(
          "mt-[16px] scroll-mt-[12px] rounded-[13px] outline-none transition-shadow",
          lit === CONNECTORS_ID && LIT_RING,
        )}
        data-lit={lit === CONNECTORS_ID ? "true" : undefined}
        id={CONNECTORS_ID}
        tabIndex={-1}
      >
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
          ) : shownConnectors.length === 0 ? (
            <NoMatch onClear={clearFilters} title="没有匹配的连接器" />
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
