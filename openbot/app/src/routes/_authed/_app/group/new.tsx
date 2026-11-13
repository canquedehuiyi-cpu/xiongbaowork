import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { CreateGroupForm } from "@/components/wakers/create-group-form";
import { channelKeys } from "@/lib/channels/queries";

/**
 * 新建群组: name it, pick two or more employees in the order they will answer, and the group and its
 * chat are made together (`POST /api/waker-groups`), then the chat is opened for its first message.
 * The server refuses any employee this person cannot see, exactly as for a one-employee channel.
 *
 * 熊宝 v0.2.7 的页面，#452 曾把它改成跳到「新对话」（那里在「发给」里选两位以上员工也能开群聊，随第一条消息
 * 一起建）。用户找不到入口，所以页面恢复了，侧栏「新建群组」打开这里；新对话页的多选照旧保留。
 */
export const Route = createFileRoute("/_authed/_app/group/new")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 flex h-12 shrink-0 flex-row items-center gap-1.5 border-border border-b px-3">
        <SidebarToggle />
        <span className="font-medium text-[14px] tracking-tight">新建群组</span>
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
          <CreateGroupForm
            onCreated={({ channel }) => {
              queryClient.setQueryData(channelKeys.detail(channel.id), channel);
              void navigate({
                to: "/group/$channelId",
                params: { channelId: channel.id },
                replace: true,
              });
            }}
            variant="page"
          />
        </div>
      </div>
    </div>
  );
}
