import { IconListCheck } from "@tabler/icons-react";
import { BotActivitySections } from "@/components/bot-profile/activity";
import { BotNeedsYou } from "@/components/needs-you/board";
import { useMuse } from "../context";
import { MuseEmpty, MuseScreen } from "../ui";

/**
 * Activity: what the centre Bot is waiting on you for, then what it is doing, has scheduled and has
 * finished. Both are OpenBot's own sections from the Bot's page, under OpenMuse's title.
 */
export function ActivityScreen() {
  const { bot } = useMuse();
  return (
    <MuseScreen title="动态">
      {bot ? (
        <div className="[&>section:first-child]:mt-0">
          <BotNeedsYou agentId={bot.id} />
          <BotActivitySections agentId={bot.id} />
        </div>
      ) : (
        <NoBot />
      )}
    </MuseScreen>
  );
}

export function NoBot() {
  return (
    <MuseEmpty
      detail="在员工页点「新建员工」创建一位。"
      icon={IconListCheck}
      title="还没有员工"
    />
  );
}
