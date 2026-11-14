import { IconSparkles } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { StatusDot } from "@/components/agents/status-dot";
import {
  employeeGroups,
  isPendingSummon,
  listedEmployees,
} from "@/components/app-sidebar/roster";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  SidebarToggleBar,
  useSidebarToggleVisible,
} from "@/components/layout/sidebar-toggle";
import {
  knownPresence,
  type Presence,
  presenceDoing,
  usePresence,
} from "@/lib/agents/presence";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";
import {
  EmployeeCard,
  NO_DEPARTMENT,
  NowDoing,
  TONE,
  useEmployeeCard,
} from "./employee-card";

/**
 * 部门的先后：熊宝预设员工用的几个部门按这个顺序排（和规格里列的一样），别的部门按名字排在后面，
 * 「未分组」永远最后。
 */
const DEPARTMENT_ORDER = [
  "研发部",
  "产品部",
  "设计部",
  "测试部",
  "运营部",
  "行政部",
  "总经办",
];

/** 「招一位新同事」卡跟在这个部门后面（设计稿）；没有这个部门时跟在最后一组后面。 */
const RECRUIT_AFTER = "研发部";

const collator = new Intl.Collator("zh-Hans-CN");

export type DepartmentGroup = { name: string; members: AgentProfile[] };

/** 员工按部门分组：组的先后见 `DEPARTMENT_ORDER`，组内按名字。没有部门的归「未分组」。 */
export function departmentGroups(
  employees: readonly AgentProfile[],
): DepartmentGroup[] {
  const byName = new Map<string, AgentProfile[]>();
  for (const employee of employees) {
    const name = employee.department?.trim() || NO_DEPARTMENT;
    byName.set(name, [...(byName.get(name) ?? []), employee]);
  }
  const rank = (name: string) => {
    if (name === NO_DEPARTMENT) return DEPARTMENT_ORDER.length + 1;
    const known = DEPARTMENT_ORDER.indexOf(name);
    return known === -1 ? DEPARTMENT_ORDER.length : known;
  };
  return [...byName.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || collator.compare(a, b))
    .map(([name, members]) => ({
      name,
      members: [...members].sort((a, b) => collator.compare(a.name, b.name)),
    }));
}

const cardClassName = cn(
  "grid h-full w-full cursor-pointer gap-2.5 rounded-[14px] border p-3.5 text-left transition-[transform,border-color] duration-150 motion-safe:hover:-translate-y-0.5 hover:border-[color:var(--wb-line2,var(--border))]",
  TONE.card,
  TONE.line,
  TONE.fg,
  TONE.focus,
);

function EmployeeTile({
  agent,
  presence,
  onOpen,
}: {
  agent: AgentProfile;
  /** 此刻的状态；读不到时没有，卡上就不画状态点和「此刻」。 */
  presence?: Presence;
  onOpen: (agentId: string) => void;
}) {
  const known = knownPresence(presence);
  const doing = presenceDoing(known);
  return (
    <li className="flex">
      <button
        aria-haspopup="dialog"
        className={cardClassName}
        data-employee={agent.id}
        onClick={() => onOpen(agent.id)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="relative shrink-0">
            <span aria-hidden="true">
              <ChannelAvatar participantIds={[agent.id]} size={42} />
            </span>
            <StatusDot
              className="border-[color:var(--wb-card,var(--card))]"
              overlay
              status={known?.status}
            />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-semibold text-[14px]">
              {agent.name}
            </span>
            {agent.title ? (
              <span className={cn("mt-0.5 truncate text-[12px]", TONE.muted)}>
                {agent.title}
              </span>
            ) : null}
          </span>
        </span>
        {doing ? <NowDoing doing={doing} /> : null}
      </button>
    </li>
  );
}

/**
 * 「招一位新同事 → 人才市场」，第三行是人才市场里还没召唤的几位预设员工的名字（有才写）。写名字不写职务：
 * 人才市场的卡片上认的是名字（通用助手、运营助手），职务只是名字下面那一行。本人的分身不算「新同事」。
 */
function RecruitTile({ pending }: { pending: readonly AgentProfile[] }) {
  const names = [
    ...new Set(
      pending
        .filter((agent) => agent.summonKind === "preset")
        .map((agent) => agent.name.trim())
        .filter(Boolean),
    ),
  ];
  const sample = names.slice(0, 3).join("、");
  return (
    <li className="flex">
      <Link
        className={cn(
          cardClassName,
          "border-[color:var(--wb-market-line,var(--border))] bg-[image:var(--wb-market-glow,none)]",
        )}
        to="/bots"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className={cn(
              "grid size-[42px] shrink-0 place-items-center rounded-[12px] bg-[image:var(--wb-market-icon,none)] [&>svg]:size-[18px]",
              TONE.card2,
              TONE.gold,
            )}
          >
            <IconSparkles />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-semibold text-[14px]">
              招一位新同事
            </span>
            <span className={cn("mt-0.5 truncate text-[12px]", TONE.muted)}>
              去人才市场召唤
            </span>
          </span>
        </span>
        {sample ? (
          <span
            className={cn(
              "truncate rounded-[8px] px-2 py-1.5 text-[12px]",
              TONE.card2,
              TONE.fg2,
            )}
          >
            {names.length > 3 ? `${sample}…` : sample}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

const gridClassName =
  "m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3 p-0";

/** 组织架构本身：标题，然后一组一个部门，每位员工一张卡，点开是员工名片。 */
function OrgChart({ onOpen }: { onOpen: (agentId: string) => void }) {
  const agents = useQuery(agentListQueryOptions());
  const showToggle = useSidebarToggleVisible();
  const employees = employeeGroups(listedEmployees(agents.data)).summoned;
  // 整张组织架构一次读出所有员工此刻的状态，不是每张卡一个。
  const presence = usePresence(employees.map((agent) => agent.id));
  const pending = (agents.data ?? []).filter(isPendingSummon);
  const groups = departmentGroups(employees);
  const research = groups.findIndex((group) => group.name === RECRUIT_AFTER);
  const recruitAt = research === -1 ? groups.length - 1 : research;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", TONE.fg)} data-contacts>
      {showToggle ? <SidebarToggleBar /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-[18px] px-[13px] py-[22px] md:px-[26px]">
          <header className="flex items-baseline justify-between gap-3">
            <h1 className="m-0 font-bold text-[18px] tracking-[-.01em]">
              组织架构
            </h1>
            {agents.data ? (
              <span className={cn("text-[12px] tabular-nums", TONE.muted)}>
                {employees.length} 人
              </span>
            ) : null}
          </header>
          {agents.isPending ? (
            <p className={cn("m-0 text-[13px]", TONE.muted)}>正在加载员工…</p>
          ) : agents.isError && !agents.data ? (
            <p className={cn("m-0 text-[13px]", TONE.muted)}>
              <span role="alert">员工加载失败。</span>
              <button
                className={cn(
                  "ml-1 cursor-pointer border-0 bg-transparent p-0 underline",
                  TONE.fg,
                  TONE.focus,
                )}
                disabled={agents.isFetching}
                onClick={() => void agents.refetch()}
                type="button"
              >
                {agents.isFetching ? "正在重试…" : "重试"}
              </button>
            </p>
          ) : groups.length === 0 ? (
            <>
              <p className={cn("m-0 text-[13px]", TONE.muted)}>还没有员工。</p>
              <ul className={gridClassName}>
                <RecruitTile pending={pending} />
              </ul>
            </>
          ) : (
            groups.map((group, index) => (
              <section aria-label={group.name} key={group.name}>
                <h2
                  className={cn(
                    "m-0 mb-2.5 flex justify-between font-semibold text-[13px] tracking-[.04em]",
                    TONE.muted,
                  )}
                >
                  <span>{group.name}</span>
                  <span className="tabular-nums">
                    {group.members.length} 人
                  </span>
                </h2>
                <ul className={gridClassName}>
                  {group.members.map((agent) => (
                    <EmployeeTile
                      agent={agent}
                      key={agent.id}
                      onOpen={onOpen}
                      presence={presence.get(agent.id)}
                    />
                  ))}
                  {index === recruitAt ? (
                    <RecruitTile pending={pending} />
                  ) : null}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** 没有工作台外壳的皮肤里，通讯录页自己挂名片。 */
function StandaloneContacts() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <OrgChart onOpen={setOpen} />
      {open ? (
        <EmployeeCard agentId={open} key={open} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

/**
 * 通讯录 › 组织架构（`/contacts`，设计稿通讯录那一屏的主区）：本人的员工按部门分组，每位一张卡（头像、
 * 名字、职务），点开是员工名片；研发部末尾是「招一位新同事」，去人才市场。员工和侧栏「员工」是同一份
 * （`listedEmployees` + `employeeGroups`）。
 *
 * 默认皮肤里名片挂在工作台外壳上（`useEmployeeCard`）；别的皮肤（包括「经典」）里这一页照样能打开，名片
 * 挂在页面自己身上。
 */
export function ContactsPage() {
  const cards = useEmployeeCard();
  if (cards) return <OrgChart onOpen={cards.openEmployeeCard} />;
  return <StandaloneContacts />;
}
