import { BotOrb } from "@/components/agents/bot-orb";
import { StatusDot } from "@/components/agents/status-dot";
import { ChosenPortrait } from "@/components/channels/avatar";
import { VisibilityTag } from "@/components/channels/visibility-tag";
import type { AvatarMotionState } from "@/components/portraits/preset-animations";
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
  const now = presenceSummary(known);
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
          <VisibilityTag
            className="h-5 shrink-0 px-1.5 font-semibold text-[11px]"
            visibility={agent.visibility}
          />
          {known && agent.title ? (
            <span
              className="min-w-0 truncate text-[12px] text-muted-foreground"
              title={agent.title}
            >
              {agent.title}
            </span>
          ) : null}
        </div>
        {known ? (
          <p
            className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground"
            data-presence={known.status}
          >
            <StatusDot decorative status={known.status} />
            <span className="min-w-0 truncate" title={now}>
              {now}
            </span>
          </p>
        ) : agent.title ? (
          <p
            className="truncate text-[12px] text-muted-foreground"
            title={agent.title}
          >
            {agent.title}
          </p>
        ) : null}
      </div>
    </div>
  );
}
