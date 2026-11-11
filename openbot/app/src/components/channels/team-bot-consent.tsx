import { IconKey } from "@tabler/icons-react";
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
    /*
     * Waiting on the person, so it wears the redesign's attention treatment (docs/design/ios-studio):
     * a soft red ground and a red hairline, the white primary choice first, the rest outlined.
     */
    <section
      aria-label="等你授权"
      className="flex flex-col gap-2.5 rounded-[14px] border border-signal/30 bg-signal-soft p-3.5 text-[13px] leading-relaxed"
      data-team-bot-consent={serverId}
    >
      <p className="flex items-center gap-1.5 font-medium text-[12px] text-signal-ink">
        <IconKey aria-hidden className="size-[14px]" />
        等你授权
      </p>
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
        <p className="text-signal-ink" role="alert">
          {answer.error.message}
        </p>
      ) : null}
    </section>
  );
}
