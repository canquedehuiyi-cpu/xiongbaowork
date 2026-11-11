import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";
import { createGroupMutationOptions } from "@/lib/groups";

/**
 * 新建群聊: pick two or more employees, in the order they will answer, and the 群聊 is made empty
 * (`POST /api/groups`, which seeds that order), then opened for its first message. It is an ordinary
 * channel holding several employees; the server refuses any employee this person cannot see, exactly
 * as it does for a one-employee channel.
 *
 * 熊宝 v0.2.7 的页面，#452 曾把它改成跳到「新对话」（那里在「发给」里选两位以上员工也能开群聊，随第一条消息
 * 一起建）。用户找不到入口，所以页面恢复了，侧栏「新建群聊」打开这里；新对话页的多选照旧保留。
 */
export const Route = createFileRoute("/_authed/_app/group/new")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const profiles = useQuery(agentListQueryOptions());
  const create = useMutation(createGroupMutationOptions(queryClient));
  const [chosen, setChosen] = useState<string[]>([]);

  const start = async () => {
    const channel = await create.mutateAsync(chosen);
    queryClient.setQueryData(channelKeys.detail(channel.id), channel);
    await navigate({
      to: "/group/$channelId",
      params: { channelId: channel.id },
      replace: true,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 flex h-12 shrink-0 flex-row items-center gap-1.5 border-border border-b px-3">
        <SidebarToggle />
        <span className="font-medium text-[14px] tracking-tight">新建群聊</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/*
         * An open heading and one list (docs/design/ios-studio): the coworkers as rows of a single
         * hairline-bordered panel, the chosen ones on a lighter plate with their place in the
         * speaking order spelled out, and the one primary action — white — under it.
         */}
        <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-[13px] py-8 md:px-4">
          <header className="flex flex-col gap-1.5">
            <h1 className="font-bold text-[22px] leading-tight tracking-tight">
              选几位员工一起聊
            </h1>
            <p className="text-pretty text-[13px] text-muted-foreground leading-relaxed">
              至少选两位员工，按回答的先后顺序排列。每位都能看到其他员工说了什么，也可以用
              @名字 把对话交给另一位。
            </p>
          </header>
          {profiles.isError ? (
            <p
              className="rounded-[12px] border border-signal/30 bg-signal-soft px-3 py-2 text-[13px] text-signal-ink"
              role="alert"
            >
              {profiles.error.message}
            </p>
          ) : null}
          {profiles.isPending ? (
            <p className="text-[13px] text-muted-foreground" role="status">
              正在读取员工…
            </p>
          ) : null}
          {profiles.data && profiles.data.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              还没有员工可以拉进群聊。
            </p>
          ) : null}
          {profiles.data?.length ? (
            <div className="flex flex-col overflow-hidden rounded-[14px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]">
              {profiles.data.map((profile) => {
                const checked = chosen.includes(profile.id);
                return (
                  <label
                    className="flex min-h-[48px] cursor-pointer items-center gap-2.5 border-border border-b px-3 py-2 last:border-b-0 hover:bg-foreground/[0.03] has-[[data-checked]]:bg-accent"
                    htmlFor={`group-bot-${profile.id}`}
                    key={profile.id}
                  >
                    <Checkbox
                      aria-label={profile.name}
                      checked={checked}
                      id={`group-bot-${profile.id}`}
                      onCheckedChange={(next) =>
                        setChosen((current) =>
                          next
                            ? [...current, profile.id]
                            : current.filter((id) => id !== profile.id),
                        )
                      }
                    />
                    <ChannelAvatar participantIds={[profile.id]} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-[13px]">
                        {profile.name}
                      </span>
                      {profile.title ? (
                        <span className="block truncate text-[12px] text-muted-foreground">
                          {profile.title}
                        </span>
                      ) : null}
                    </span>
                    {checked ? (
                      <span className="shrink-0 rounded-full border border-signal/30 bg-signal-soft px-2 py-0.5 text-[11px] text-signal-ink">
                        第 {chosen.indexOf(profile.id) + 1} 个回答
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          ) : null}
          {create.error ? (
            <p
              className="rounded-[12px] border border-signal/30 bg-signal-soft px-3 py-2 text-[13px] text-signal-ink"
              role="alert"
            >
              {create.error.message}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={chosen.length < 2 || create.isPending}
              onClick={() => void start().catch(() => {})}
            >
              {create.isPending ? "正在创建…" : "开始群聊"}
            </Button>
            <span className="text-[12px] text-faint" aria-live="polite">
              {chosen.length < 2
                ? `已选 ${chosen.length} 位，至少还要 ${2 - chosen.length} 位`
                : `已选 ${chosen.length} 位`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
