import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  assignTeamBotMutationOptions,
  clearTeamBotConsentsMutationOptions,
  publishTeamBotMutationOptions,
  type TeamBot,
  teamBotLink,
  teamBotsQueryOptions,
  unpublishTeamBotMutationOptions,
} from "@/lib/team-bots";

/**
 * Team Bots: find the Bots teammates published, publish your own to the team or to named people and
 * groups, and (administrators) put one in a group's sidebars. A chat with a Team Bot is always the
 * teammate's own; its owner cannot read it.
 */
export const Route = createFileRoute("/_authed/_app/team-bots")({
  component: TeamBotsPage,
});

const list = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

function TeamBotsPage() {
  const data = useQuery(teamBotsQueryOptions());
  const me = useQuery(currentUserQueryOptions()).data;
  const clear = useMutation(clearTeamBotConsentsMutationOptions());
  const bots = data.data?.teamBots ?? [];
  const shared = bots.filter((bot) => !bot.mine);
  const mine = bots.filter((bot) => bot.mine);

  return (
    <PageShell
      description="同事发布出来的员工，以及你共享出去的员工。和团队 Bot 的每段对话只属于正在对话的那个人。"
      title="团队 Bot"
      width="wide"
    >
      {data.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {data.error.message}
        </p>
      ) : null}
      <PageSection title="你可以用的">
        {shared.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有人向你发布员工。
          </p>
        ) : (
          shared.map((bot) => <TeamBotRow bot={bot} key={bot.id} />)
        )}
      </PageSection>
      <PageSection title="你的">
        {mine.map((bot) => (
          <div className="flex flex-col gap-2" key={bot.id}>
            <TeamBotRow bot={bot} />
            <PublishForm botId={bot.id} current={bot} />
          </div>
        ))}
        {(data.data?.publishable ?? []).length ? (
          <PublishNew publishable={data.data?.publishable ?? []} />
        ) : mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            你还没有可以发布的员工。
          </p>
        ) : null}
      </PageSection>
      {me?.role === "admin" ? (
        <PageSection title="分配给分组">
          <p className="text-sm text-muted-foreground">
            分配出去的员工会出现在每位成员的侧栏里，成员不能隐藏它。用 *
            表示整个团队。
          </p>
          {bots.map((bot) => (
            <Assignments bot={bot} key={bot.id} />
          ))}
        </PageSection>
      ) : null}
      <PageSection title="你的账户">
        <p className="text-sm text-muted-foreground">
          团队 Bot
          用的是它主人连接的应用；只有你在它出示的卡片上点了允许，它才会用你自己的账户。
        </p>
        <div className="flex items-center gap-2">
          <Button
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
            size="sm"
            variant="outline"
          >
            清除连接器偏好
          </Button>
          {clear.isSuccess ? (
            <span className="text-sm text-muted-foreground" role="status">
              已清除。团队 Bot 会重新问你。
            </span>
          ) : null}
        </div>
      </PageSection>
    </PageShell>
  );
}

function TeamBotRow({ bot }: { bot: TeamBot }) {
  const queryClient = useQueryClient();
  const unpublish = useMutation(unpublishTeamBotMutationOptions(queryClient));
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
      data-team-bot={bot.id}
    >
      <ChannelAvatar participantIds={[bot.id]} size={28} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{bot.name}</span>
        <span className="truncate text-sm text-muted-foreground">
          {bot.title}
          {bot.assigned ? " · 已分配给你" : ""}
          {bot.mine && !bot.visibleToTeam
            ? " · 在有真实名字和描述之前，同事看不到它"
            : ""}
          {bot.mine
            ? bot.audience === "team"
              ? " · 已发布给整个团队"
              : ` · 已发布给 ${[...(bot.people ?? []), ...(bot.groups ?? []).map((group) => `分组 ${group}`)].join("、")}`
            : ""}
        </span>
      </div>
      <Button
        render={(props) => (
          <Link {...props} search={{ agent: bot.id }} to="/channel/new" />
        )}
        size="sm"
      >
        开始私聊
      </Button>
      <Button
        onClick={() =>
          void navigator.clipboard
            .writeText(teamBotLink(bot.id))
            .then(() => setCopied(true))
        }
        size="sm"
        variant="outline"
      >
        {copied ? "已复制" : "复制链接"}
      </Button>
      {bot.mine ? (
        <Button
          disabled={unpublish.isPending}
          onClick={() => unpublish.mutate(bot.id)}
          size="sm"
          variant="ghost"
        >
          取消发布
        </Button>
      ) : null}
    </div>
  );
}

function PublishNew({
  publishable,
}: {
  publishable: { id: string; name: string }[];
}) {
  const [botId, setBotId] = useState(publishable[0]?.id ?? "");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <label className="grid gap-1 text-sm">
        发布你的一位员工
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          onChange={(event) => setBotId(event.target.value)}
          value={botId}
        >
          {publishable.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </label>
      {botId ? <PublishForm botId={botId} key={botId} /> : null}
    </div>
  );
}

/** Who a Bot is published to: the whole team, or named people and groups. */
function PublishForm({ botId, current }: { botId: string; current?: TeamBot }) {
  const queryClient = useQueryClient();
  const publish = useMutation(publishTeamBotMutationOptions(queryClient));
  const [audience, setAudience] = useState<"team" | "people">(
    current?.audience ?? "team",
  );
  const [emails, setEmails] = useState((current?.people ?? []).join(", "));
  const [groups, setGroups] = useState((current?.groups ?? []).join(", "));
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        publish.mutate({
          botId,
          audience,
          emails: audience === "people" ? list(emails) : [],
          groups: audience === "people" ? list(groups) : [],
        });
      }}
    >
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            checked={audience === "team"}
            name={`audience-${botId}`}
            onChange={() => setAudience("team")}
            type="radio"
          />
          整个团队
        </label>
        <label className="flex items-center gap-1.5">
          <input
            checked={audience === "people"}
            name={`audience-${botId}`}
            onChange={() => setAudience("people")}
            type="radio"
          />
          指定的人或分组
        </label>
      </div>
      {audience === "people" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            aria-label="指定的人（邮箱）"
            onChange={(event) => setEmails(event.target.value)}
            placeholder="填邮箱，用逗号分隔"
            value={emails}
          />
          <Input
            aria-label="分组"
            onChange={(event) => setGroups(event.target.value)}
            placeholder="分组，用逗号分隔"
            value={groups}
          />
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button disabled={publish.isPending} size="sm" type="submit">
          {current ? "更新" : "发布到团队"}
        </Button>
        {publish.error ? (
          <span className="text-sm text-destructive" role="alert">
            {publish.error.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function Assignments({ bot }: { bot: TeamBot }) {
  const queryClient = useQueryClient();
  const assign = useMutation(assignTeamBotMutationOptions(queryClient));
  const [group, setGroup] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">{bot.name}</span>
      {(bot.assignments ?? []).map((name) => (
        <Button
          aria-label={`移除 ${name}`}
          key={name}
          onClick={() =>
            assign.mutate({ botId: bot.id, group: name, remove: true })
          }
          size="sm"
          variant="outline"
        >
          {name === "*" ? "整个团队" : name} ×
        </Button>
      ))}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          assign.mutate(
            { botId: bot.id, group },
            { onSuccess: () => setGroup("") },
          );
        }}
      >
        <Input
          aria-label={`把 ${bot.name} 分配给分组`}
          className="w-40"
          onChange={(event) => setGroup(event.target.value)}
          placeholder="分组，或 *"
          value={group}
        />
        <Button
          disabled={!group.trim() || assign.isPending}
          size="sm"
          type="submit"
        >
          分配
        </Button>
      </form>
      {assign.error ? (
        <span className="text-destructive" role="alert">
          {assign.error.message}
        </span>
      ) : null}
    </div>
  );
}
