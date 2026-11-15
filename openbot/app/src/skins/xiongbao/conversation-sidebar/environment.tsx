import {
  IconCloud,
  IconCpu,
  IconDeviceLaptop,
  IconFolder,
  IconPlus,
  IconSettings,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { StatusDot } from "@/components/agents/status-dot";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ProjectPicker } from "@/components/projects/project-picker";
import { PRESENCE_WORD } from "@/lib/agents/presence";
import { shortName } from "@/lib/brand";
import type { SidebarEnvironment } from "../../../../../shared/conversation-sidebar";

/**
 * 「环境」：员工在哪干活（云端，或哪台电脑、在不在线）、项目或工作文件夹、模型。齿轮去员工现有的
 * 配置页（侧栏里不编辑员工）；项目那一行的「+」打开现有的项目选择器。
 *
 * 群组里换成成员列表（{@link MembersBody}）：头像带状态点、名字、在哪 · 此刻在做什么。
 */

const ICON = "size-4 shrink-0 stroke-[1.8] text-(--wb-fg2)";
const ROW = "flex min-h-7 items-center gap-2.5 text-[13px] text-(--wb-fg)";
const ROW_BUTTON =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-(--wb-radius-sm) text-(--wb-muted) outline-none hover:bg-(--wb-hover) hover:text-(--wb-fg) focus-visible:outline-2 focus-visible:outline-(--wb-accent)";

/** 外部员工的模型说明把「用你自己的订阅」放到第二行。 */
const SUBSCRIPTION = "用你自己的订阅";

function where(environment: SidebarEnvironment): string {
  if (environment.kind === "cloud") return "云端";
  return environment.deviceName ?? "电脑";
}

function modelName(environment: SidebarEnvironment): string | null {
  const { model } = environment;
  if (!model) return null;
  return model.external ? model.external.harness : model.label;
}

/** 收起时标题右边的一句：「云端 · DeepSeek-V3」。 */
export function environmentSummary(environment: SidebarEnvironment): string {
  return [where(environment), modelName(environment)]
    .filter(Boolean)
    .join(" · ");
}

export function EnvironmentIcon({
  environment,
}: {
  environment?: SidebarEnvironment;
}) {
  return environment?.kind === "device" ? (
    <IconDeviceLaptop aria-hidden="true" className="size-[18px] stroke-[1.8]" />
  ) : (
    <IconCloud aria-hidden="true" className="size-[18px] stroke-[1.8]" />
  );
}

function Row({
  icon,
  trailing,
  children,
}: {
  icon: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={ROW}>
      {icon}
      {children}
      {trailing ? (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {trailing}
        </span>
      ) : null}
    </div>
  );
}

function Online({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[12px] ${
        online ? "text-(--wb-green-fg)" : "text-(--wb-muted)"
      }`}
    >
      <span
        aria-hidden="true"
        className={`size-[7px] rounded-full ${
          online ? "bg-(--wb-green)" : "bg-(--wb-gray)"
        }`}
      />
      {online ? "在线" : "离线"}
    </span>
  );
}

export function EnvironmentBody({
  environment,
  agentId,
}: {
  environment: SidebarEnvironment;
  agentId?: string;
}) {
  const [picking, setPicking] = useState(false);
  const external = environment.model?.external;
  const settings = agentId ? (
    <Link
      aria-label="员工设置"
      className={ROW_BUTTON}
      params={{ agentId }}
      to="/bots/$agentId/setup"
    >
      <IconSettings aria-hidden="true" className="size-[15px] stroke-[1.8]" />
    </Link>
  ) : null;
  return (
    <>
      {environment.kind === "cloud" ? (
        <Row
          icon={<IconCloud aria-hidden="true" className={ICON} />}
          trailing={settings}
        >
          <span className="min-w-0 truncate">云端 · {shortName()}托管</span>
        </Row>
      ) : (
        <Row
          icon={<IconDeviceLaptop aria-hidden="true" className={ICON} />}
          trailing={
            environment.online === undefined && !settings ? null : (
              <>
                {environment.online === undefined ? null : (
                  <Online online={environment.online} />
                )}
                {settings}
              </>
            )
          }
        >
          <span className="min-w-0 truncate">{where(environment)}</span>
        </Row>
      )}
      {environment.project ? (
        <Row
          icon={<IconFolder aria-hidden="true" className={ICON} />}
          trailing={
            agentId ? (
              <button
                aria-expanded={picking}
                aria-label="关联项目"
                className={ROW_BUTTON}
                onClick={() => setPicking((open) => !open)}
                type="button"
              >
                <IconPlus
                  aria-hidden="true"
                  className="size-[15px] stroke-[1.8]"
                />
              </button>
            ) : null
          }
        >
          <span className="min-w-0 truncate">
            项目：{environment.project.name}
          </span>
        </Row>
      ) : null}
      {picking && agentId && environment.project ? (
        <div className="pl-[26px] text-[12.5px] text-(--wb-fg2)">
          <ProjectPicker agentId={agentId} compact />
        </div>
      ) : null}
      {environment.workdirName ? (
        <Row icon={<IconFolder aria-hidden="true" className={ICON} />}>
          <span className="min-w-0 truncate">
            工作文件夹：{environment.workdirName}
          </span>
        </Row>
      ) : null}
      {external ? (
        <>
          <Row icon={<IconCpu aria-hidden="true" className={ICON} />}>
            <span className="min-w-0 truncate">
              外部员工 · {external.harness}
            </span>
          </Row>
          <span className="pl-[26px] text-(--wb-muted) text-[12px]">
            {SUBSCRIPTION}
          </span>
        </>
      ) : environment.model ? (
        <Row icon={<IconCpu aria-hidden="true" className={ICON} />}>
          <span className="min-w-0 truncate">
            模型：{environment.model.label}
          </span>
        </Row>
      ) : null}
    </>
  );
}

type Member = NonNullable<SidebarEnvironment["members"]>[number];

/** 群组收起时标题右边的一句：「3 位员工 · 2 个人」。 */
export function membersSummary(
  members: readonly Member[],
  peopleCount?: number,
): string {
  return [
    `${members.length} 位员工`,
    peopleCount === undefined ? null : `${peopleCount} 个人`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 「在哪 · 在做什么」：在忙时是那件事，否则是状态的词。 */
function memberLine(member: Member): string {
  const now =
    member.status === "working"
      ? (member.doing ?? PRESENCE_WORD.working)
      : member.status === "offline"
        ? "离线"
        : member.status === "unknown"
          ? null
          : PRESENCE_WORD[member.status];
  return [member.where, now].filter(Boolean).join(" · ");
}

function MemberDot({ status }: { status: Member["status"] }) {
  if (status !== "offline") return <StatusDot overlay status={status} />;
  return (
    <span
      aria-label="离线"
      className="absolute -right-0.5 -bottom-0.5 inline-block size-3 shrink-0 rounded-full border-2 border-(--wb-list) bg-(--wb-gray)"
      data-status-dot="offline"
      role="img"
      title="离线"
    />
  );
}

export function MembersBody({
  members,
  peopleCount,
}: {
  members: readonly Member[];
  peopleCount?: number;
}) {
  return (
    <>
      <span className="text-(--wb-muted) text-[12.5px]">
        {membersSummary(members, peopleCount)}
      </span>
      {members.map((member) => (
        <div
          className="flex min-h-10 items-center gap-2.5"
          data-member={member.agentId}
          key={member.agentId}
        >
          <span className="relative shrink-0">
            <ChannelAvatar participantIds={[member.agentId]} size={32} />
            <MemberDot status={member.status} />
          </span>
          <span className="min-w-0">
            <b className="block truncate font-semibold text-(--wb-fg) text-[13px]">
              {member.name}
            </b>
            <small className="block truncate text-(--wb-muted) text-[12px]">
              {memberLine(member)}
            </small>
          </span>
        </div>
      ))}
    </>
  );
}
