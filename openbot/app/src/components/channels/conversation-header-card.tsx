import { BotOrb } from "@/components/agents/bot-orb";
import { ChosenPortrait } from "@/components/channels/avatar";
import { VisibilityTag } from "@/components/channels/visibility-tag";
import type { AvatarMotionState } from "@/components/portraits/preset-animations";
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
 */
export function ConversationHeaderCard({
  agent,
  motion,
}: {
  agent: AgentProfile;
  motion?: AvatarMotionState;
}) {
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
        </div>
        {agent.title ? (
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
