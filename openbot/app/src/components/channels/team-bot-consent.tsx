import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type TeamBotConsentDecision,
  teamBotConsentMutationOptions,
} from "@/lib/team-bots";

/**
 * A Team Bot asking to use this person's own account on one server, where its owner has not
 * connected one. Allow once covers the next call, Always allow covers this Bot (or every Team Bot)
 * until cleared in Team Bots, Skip leaves it using nothing of theirs. The Bot is then asked again by the person.
 */
export function TeamBotConsentCard({
  botId,
  serverId,
  message,
}: {
  botId: string;
  serverId: string;
  message: string;
}) {
  const answer = useMutation(teamBotConsentMutationOptions());
  const [chosen, setChosen] = useState<TeamBotConsentDecision | null>(null);
  const choose = (decision: TeamBotConsentDecision) =>
    answer.mutate(
      { botId, serverId, decision },
      { onSuccess: () => setChosen(decision) },
    );
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
      data-team-bot-consent={serverId}
    >
      <p>{message}</p>
      {chosen ? (
        <p className="text-muted-foreground" role="status">
          {chosen === "skip"
            ? "已跳过，没有用到你的任何东西。"
            : chosen === "allow_once"
              ? "已允许一次。请让员工再试一次。"
              : chosen === "allow_all_team_bots"
                ? "已对所有团队 Bot 永久允许。请让它再试一次。"
                : "已对这位员工永久允许。请让它再试一次。"}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={answer.isPending}
            onClick={() => choose("allow_once")}
            size="sm"
          >
            允许一次
          </Button>
          <Button
            disabled={answer.isPending}
            onClick={() => choose("allow_always")}
            size="sm"
            variant="outline"
          >
            对这位员工永久允许
          </Button>
          <Button
            disabled={answer.isPending}
            onClick={() => choose("allow_all_team_bots")}
            size="sm"
            variant="outline"
          >
            对所有团队 Bot 永久允许
          </Button>
          <Button
            disabled={answer.isPending}
            onClick={() => choose("skip")}
            size="sm"
            variant="ghost"
          >
            跳过
          </Button>
        </div>
      )}
      {answer.error ? (
        <p className="text-destructive" role="alert">
          {answer.error.message}
        </p>
      ) : null}
    </div>
  );
}
