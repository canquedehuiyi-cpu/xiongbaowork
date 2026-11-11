/*
 * M5b 第 0 步：从 `routes/_authed/_app/team-bots.tsx` 剪出的页面主体，原样保留，地址改成重定向（/team-bots → /bots）。
 * 各组在新路由里接这个组件，再按新结构调整其中的链接与文案。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import {
  PANEL_FACE,
  PROFILE_TAG,
  ProfileAlert,
  ProfileEmpty,
  ProfilePanel,
  ProfileSection,
} from "@/components/bot-profile/profile-kit";
import { ChannelAvatar } from "@/components/channels/avatar";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
import { cn } from "@/lib/utils";

/**
 * Team Bots: find the Bots teammates published, publish your own to the team or to named people and
 * groups, and (administrators) put one in a group's sidebars. A chat with a Team Bot is always the
 * teammate's own; its owner cannot read it.
 */

const list = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

export function TeamBotsPage() {
  const data = useQuery(teamBotsQueryOptions());
  const me = useQuery(currentUserQueryOptions()).data;
  const clear = useMutation(clearTeamBotConsentsMutationOptions());
  const bots = data.data?.teamBots ?? [];
  const shared = bots.filter((bot) => !bot.mine);
  const mine = bots.filter((bot) => bot.mine);

  /*
   * Drawn in the workbench frame (docs/design/ios-studio), in the 员工管理 wall's card language: each
   * Team Bot a 「角色档案」 card (face, name, role, its state as words), the person's own carrying who
   * it is published to under a hairline, and the settings below as rows in one panel.
   */
  return (
    <PageShell
      description="同事发布出来的员工，以及你共享出去的员工。和团队 Bot 的每段对话只属于正在对话的那个人。"
      title="团队 Bot"
      width="workbench"
    >
      {data.isError ? <ProfileAlert>{data.error.message}</ProfileAlert> : null}
      <div className="flex flex-col gap-[28px]">
        <ProfileSection
          action={
            data.data ? (
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {shared.length} 位
              </span>
            ) : null
          }
          title="你可以用的"
        >
          {data.isPending ? (
            <CardsSkeleton label="正在读取团队 Bot" />
          ) : shared.length === 0 ? (
            data.isError ? null : (
              <ProfileEmpty>还没有人向你发布员工。</ProfileEmpty>
            )
          ) : (
            <div className={CARD_GRID}>
              {shared.map((bot) => (
                <TeamBotRow bot={bot} key={bot.id} />
              ))}
            </div>
          )}
        </ProfileSection>
        <ProfileSection title="你的">
          {data.isPending ? (
            <CardsSkeleton label="正在读取你发布的员工" />
          ) : (
            <div className={cn(CARD_GRID, "min-[1151px]:grid-cols-2")}>
              {mine.map((bot) => (
                <TeamBotRow bot={bot} key={bot.id}>
                  <PublishForm botId={bot.id} current={bot} />
                </TeamBotRow>
              ))}
              {(data.data?.publishable ?? []).length ? (
                <PublishNew publishable={data.data?.publishable ?? []} />
              ) : mine.length === 0 && !data.isError ? (
                <ProfileEmpty className="mt-0">
                  你还没有可以发布的员工。
                </ProfileEmpty>
              ) : null}
            </div>
          )}
        </ProfileSection>
        {me?.role === "admin" ? (
          <ProfileSection
            description="分配出去的员工会出现在每位成员的侧栏里，成员不能隐藏它。用 * 表示整个团队。"
            title="分配给分组"
          >
            {bots.length === 0 ? (
              data.isPending ? null : (
                <ProfileEmpty>还没有发布出来的员工可以分配。</ProfileEmpty>
              )
            ) : (
              <ProfilePanel>
                {bots.map((bot) => (
                  <Assignments bot={bot} key={bot.id} />
                ))}
              </ProfilePanel>
            )}
          </ProfileSection>
        ) : null}
        <ProfileSection
          description="团队 Bot 用的是它主人连接的应用；只有你在它出示的卡片上点了允许，它才会用你自己的账户。"
          title="你的账户"
        >
          <ProfilePanel>
            <div className="flex flex-wrap items-center justify-between gap-[10px] px-[14px] py-[11px]">
              <span className="text-[13px] text-muted-foreground">
                {clear.isSuccess ? (
                  <span role="status">已清除。团队 Bot 会重新问你。</span>
                ) : (
                  "你点过的允许和拒绝，团队 Bot 会记住。"
                )}
              </span>
              <Button
                disabled={clear.isPending}
                onClick={() => clear.mutate()}
                size="sm"
                variant="outline"
              >
                {clear.isPending ? "正在清除…" : "清除连接器偏好"}
              </Button>
            </div>
            {clear.error ? (
              <p
                className="px-[14px] py-[9px] text-[13px] text-destructive"
                role="alert"
              >
                {clear.error.message}
              </p>
            ) : null}
          </ProfilePanel>
        </ProfileSection>
      </div>
    </PageShell>
  );
}

/** Three equal columns 11px apart, two at 1150px, one at 440px — the 员工管理 wall's grid. */
const CARD_GRID =
  "mt-[10px] grid grid-cols-1 items-start gap-[11px] min-[441px]:grid-cols-2 min-[1151px]:grid-cols-3";

function CardsSkeleton({ label }: { label: string }) {
  return (
    <div aria-label={label} className={CARD_GRID} role="status">
      <Skeleton className="h-[132px] rounded-[16px]" />
      <Skeleton className="h-[132px] rounded-[16px]" />
    </div>
  );
}

/**
 * One Team Bot as a 「角色档案」 card: its face, name and role, its state said in words (已分配给你,
 * who it is published to, whether teammates can see it yet), and its verbs at the foot. The person's
 * own carries its publish form under a hairline (`children`).
 */
function TeamBotRow({ bot, children }: { bot: TeamBot; children?: ReactNode }) {
  const queryClient = useQueryClient();
  const unpublish = useMutation(unpublishTeamBotMutationOptions(queryClient));
  const [copied, setCopied] = useState(false);
  const audience = bot.mine
    ? bot.audience === "team"
      ? "已发布给整个团队"
      : `已发布给 ${[...(bot.people ?? []), ...(bot.groups ?? []).map((group) => `分组 ${group}`)].join("、")}`
    : null;
  return (
    <div
      className={cn(
        PANEL_FACE,
        "flex min-w-0 flex-col gap-[12px] rounded-[16px] px-[14px] pt-[12px] pb-[12px]",
      )}
      data-team-bot={bot.id}
    >
      <div className="flex min-w-0 items-center gap-[10px]">
        <span className="inline-flex shrink-0 overflow-hidden rounded-[13px] shadow-[0_0_0_1px_color-mix(in_oklab,var(--foreground)_13%,transparent)]">
          <ChannelAvatar participantIds={[bot.id]} size={44} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-bold text-[16px] leading-[22px] tracking-[-0.01em]">
            {bot.name}
          </span>
          <span className="truncate text-[12px] text-muted-foreground leading-[17px]">
            {bot.title || "员工"}
          </span>
        </div>
      </div>
      {bot.assigned || audience || (bot.mine && !bot.visibleToTeam) ? (
        <div className="flex min-w-0 flex-wrap gap-[5px]">
          {bot.assigned ? (
            <span className={PROFILE_TAG}>已分配给你</span>
          ) : null}
          {audience ? (
            <span
              className={cn(PROFILE_TAG, "max-w-full truncate")}
              title={audience}
            >
              {audience}
            </span>
          ) : null}
          {bot.mine && !bot.visibleToTeam ? (
            <span
              className={cn(
                PROFILE_TAG,
                "h-auto min-h-[20px] whitespace-normal bg-signal-soft py-[3px] text-signal-ink",
              )}
            >
              在有真实名字和描述之前，同事看不到它
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-[7px] border-border border-t pt-[10px]">
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
            {unpublish.isPending ? "正在取消…" : "取消发布"}
          </Button>
        ) : null}
      </div>
      {unpublish.error ? (
        <p className="text-[13px] text-destructive" role="alert">
          {unpublish.error.message}
        </p>
      ) : null}
      {children ? (
        <div className="border-border border-t pt-[10px]">{children}</div>
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
    <div className="flex min-w-0 flex-col gap-[10px] rounded-[16px] border border-border border-dashed px-[14px] py-[12px]">
      <label className="grid gap-[6px] font-medium text-[13px]">
        发布你的一位员工
        <select
          className="h-[32px] rounded-[9px] border border-border bg-background px-[9px] font-normal text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
      className="flex flex-col gap-[9px]"
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
      <div className="flex flex-wrap gap-x-[16px] gap-y-[6px] text-[13px]">
        <label className="flex items-center gap-[6px]">
          <input
            className="accent-[var(--foreground)]"
            checked={audience === "team"}
            name={`audience-${botId}`}
            onChange={() => setAudience("team")}
            type="radio"
          />
          整个团队
        </label>
        <label className="flex items-center gap-[6px]">
          <input
            className="accent-[var(--foreground)]"
            checked={audience === "people"}
            name={`audience-${botId}`}
            onChange={() => setAudience("people")}
            type="radio"
          />
          指定的人或分组
        </label>
      </div>
      {audience === "people" ? (
        <div className="grid gap-[7px] sm:grid-cols-2">
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
      <div className="flex flex-wrap items-center gap-[8px]">
        <Button
          disabled={publish.isPending}
          size="sm"
          type="submit"
          variant={current ? "outline" : "default"}
        >
          {current ? "更新" : "发布到团队"}
        </Button>
        {publish.error ? (
          <span className="text-[13px] text-destructive" role="alert">
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
    <div className="flex flex-wrap items-center gap-[8px] px-[14px] py-[10px] text-[13px]">
      <span className="min-w-[6em] font-medium">{bot.name}</span>
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
          className="h-[32px] w-40"
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
        <span className="w-full text-destructive" role="alert">
          {assign.error.message}
        </span>
      ) : null}
    </div>
  );
}
