import { BotOrb } from "@/components/agents/bot-orb";
import { ExternalMark } from "@/components/agents/external/external-marks";
import { StatusDot } from "@/components/agents/status-dot";
import { ChosenPortrait } from "@/components/channels/avatar";
import { VisibilityTag } from "@/components/channels/visibility-tag";
import type { AvatarMotionState } from "@/components/portraits/preset-animations";
import {
  externalMark,
  externalSubtitle,
  useExternalDevice,
} from "@/lib/agents/external";
import {
  knownPresence,
  type Presence,
  presenceSummary,
} from "@/lib/agents/presence";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * The conversation header's own classes. `sticky top-0` keeps it, and the employee card in it, at the
 * top of the pane however long the chat grows; it must be a direct child of the pane's column,
 * since a sticky element only stays inside its parent.
 */
export const CONVERSATION_HEADER_CLASS =
  "sticky top-0 z-10 shrink-0 min-h-12 border-b border-border bg-background flex flex-row flex-wrap items-center justify-between px-3 py-2 gap-2";

/**
 * The compact employee card: avatar, name, title and who can see it, on one row each. The face
 * follows the same rule as everywhere else (`ChosenPortrait`: a chosen portrait, else the preset
 * face the employee was made with, else the orb).
 *
 * With `presence` (the workbench skin, 聊天工作台 Task 8) the second row is where the employee is
 * now — the status dot and 「忙碌 · 任务标题」, 「空闲」 or 「已暂停」, as the mock's header draws it —
 * and the title moves up beside the name. A presence that is missing or `unknown` changes nothing:
 * the card is drawn exactly as without it, never with placeholder words.
 *
 * An external employee (外部员工 Task 11) carries its 「外部员工 · Codex」 badge beside its name, and
 * the presence line says which computer it works on: 「忙碌 · 修登录接口的 401 · 在 何总的 MacBook Pro
 * 上」, 「离线 · 2 件排队中 · 在 … 上」. A part that is missing is left out with its 「·」.
 */
export function ConversationHeaderCard({
  agent,
  motion,
  presence,
}: {
  agent: AgentProfile;
  motion?: AvatarMotionState;
  presence?: Presence;
}) {
  const known = knownPresence(presence);
  const external = agent.external;
  const device = useExternalDevice(agent);
  const now = external
    ? externalSubtitle(presenceSummary(known), device?.name)
    : presenceSummary(known);
  // 招进来时职务就是「外部员工 · Codex」，有了标记就不再写一遍。
  const title =
    external && agent.title === externalMark(external, device)
      ? ""
      : agent.title;
  // 状态读不到时第二行照旧写职务；外部员工没有职务可写时写它在哪台电脑上。
  const fallback = title || (external ? now : "");
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="block size-10 shrink-0">
        <ChosenPortrait id={agent.id} motion={motion} size={40}>
          <BotOrb
            name={agent.name}
            seed={agent.avatarSeed || agent.id}
            size={40}
          />
        </ChosenPortrait>
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-medium text-[14px] tracking-tight">
            {agent.name}
          </span>
          {external ? (
            <ExternalMark device={device} external={external} />
          ) : (
            <VisibilityTag
              className="h-5 shrink-0 px-1.5 font-semibold text-[11px]"
              visibility={agent.visibility}
            />
          )}
          {known && title ? (
            <span
              className="min-w-0 truncate text-[12px] text-muted-foreground"
              title={title}
            >
              {title}
            </span>
          ) : null}
        </div>
        {known ? (
          <p
            className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground"
            data-presence={known.status}
          >
            {/* 忙碌时是旋转的加载图标（期一）：一眼看出员工正在干活。 */}
            <StatusDot decorative spin status={known.status} />
            <span className="min-w-0 truncate" title={now}>
              {now}
            </span>
          </p>
        ) : fallback ? (
          <p
            className="truncate text-[12px] text-muted-foreground"
            title={fallback}
          >
            {fallback}
          </p>
        ) : null}
      </div>
    </div>
  );
}
