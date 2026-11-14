import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { textMatch } from "@/components/resources/capability-tabs";
import { RunnableBadge, runnableGrade } from "@/components/resources/runnable-badge";
import { ConnectorCard } from "@/components/resources/connector-card";
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
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/**
 * 「我的」（`/capabilities/mine`，P4）：一个员工被给了什么的单一列表。
 *
 * 三块共用一次 `/api/plugins` 读，所以失败是这一页自己的告警——技能（每条带移植档位徽章）、
 * 团队（4b：`kind: "team"` 的频道行，品牌包给的专家团）和连接器（没连上的画「待绑定」，跳到
 * `/connections`）。团队块对不下发该字段的老服务端退回空态，不崩。
 *
 * 技能块在 4c 之前是一个平铺长列表：品牌包给 109 条，其中 36 条暂不可用、11 条部分可用，
 * 「我能用什么」要滚到底才数得出来。所以档位数先答数、点一下按档位收窄，搜索按标题/说明/理由
 * 收窄；两者都只过滤这一份已读到的数据，不另发请求。
 */

/**
 * 一档的筛选按钮：文案就是它的可访问名字（`暂不可用 36`），所以读屏念出来与眼睛看到的一致，
 * `aria-pressed` 说它当前是不是筛子。`null` 档（从没被移植审计过的手写技能）只在有这种技能时画。
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

export function MineScreen() {
  const page = useQuery(pluginsPageQueryOptions());

  const skills = page.data?.skills ?? [];
  const teams = page.data?.teams ?? [];
  const servers = page.data?.servers ?? [];

  const [grade, setGrade] = useState<GradeFilter>("all");
  const [query, setQuery] = useState("");
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

  const clearFilters = () => {
    setGrade("all");
    setQuery("");
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
  const pickGrade = (key: GradeFilter) =>
    setGrade((current) => (current === key ? "all" : key));

  return (
    <div className="px-1 pb-6">
      <TabHeader
        description="这个员工被给了什么：技能、团队、连接器。技能的档位是移植时逐条审出来的——完整可用能照正文干，部分可用缺了引用的文件，暂不可用缺的是运行环境或授权。"
        search={
          skills.length > 0 ? (
            <TabSearch label="搜索技能" onChange={setQuery} value={query} />
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
                  onClick={() => setGrade("all")}
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
            <CardGrid className="mt-[9px]" label="被给的技能">
              {visible.map((skill) => {
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
                    {skill.runnable &&
                    skill.runnable !== "full" &&
                    reason ? (
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
        <SectionHead id="mine-connectors-head" title="连接器" />
        <QueryState label="读不到你的连接器" query={page}>
          {servers.length === 0 ? (
            <TabEmpty
              description="品牌包或管理员把连接器加进部署后，这里会一个个列出来。"
              title="还没有被给的连接器"
            />
          ) : (
            <CardGrid className="mt-[9px]" label="被给的连接器">
              {servers.map((server) => (
                <ConnectorCard
                  action={
                    <Link
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                      to="/connections"
                    >
                      去连接
                    </Link>
                  }
                  key={server.id}
                  server={server}
                />
              ))}
            </CardGrid>
          )}
        </QueryState>
      </section>
    </div>
  );
}
