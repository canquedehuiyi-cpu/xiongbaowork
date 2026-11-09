import { IconBulb } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  ProactiveResearchSettings,
  SuggestionsInbox,
} from "@/components/suggestions/proactive-panel";
import { proactiveSuggestionsQueryOptions } from "@/lib/proactive";
import { useMuse } from "../context";
import { MuseEmpty, MuseScreen } from "../ui";
import { NoBot } from "./activity";

/**
 * Ideas: what the centre Bot's check-ins found, and its check-ins themselves. Both are OpenBot's own
 * sections, so starting, hiding and running a check-in behave as on the Bot's page.
 */
export function IdeasScreen() {
  const { bot } = useMuse();
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  if (!bot) {
    return (
      <MuseScreen title="建议">
        <NoBot />
      </MuseScreen>
    );
  }
  const none =
    suggestions.data !== undefined &&
    !suggestions.data.some((suggestion) => suggestion.agentId === bot.id);
  return (
    <MuseScreen title="建议">
      <div className="[&>section:first-child]:mt-0">
        {none ? (
          <MuseEmpty
            detail={`${bot.name}巡检时发现需要你处理的事，会出现在这里。`}
            icon={IconBulb}
            title="现在没有需要你处理的事"
          />
        ) : (
          <SuggestionsInbox agentId={bot.id} />
        )}
        <ProactiveResearchSettings agentId={bot.id} />
      </div>
    </MuseScreen>
  );
}
