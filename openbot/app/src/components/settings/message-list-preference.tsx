import { IconLayoutSidebar } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";

export function MessageListPreference() {
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, preferences.userId),
  );
  const emphasis =
    (save.isPending ? save.variables?.messageListEmphasis : undefined) ??
    preferences.data?.messageListEmphasis;

  return (
    <PageRows>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconLayoutSidebar />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>消息列表突出显示</ItemTitle>
          <ItemDescription>
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
            选择在对话列表里用大字显示哪个名字。
=======
            Choose which line stands out in the sidebar.
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            value={emphasis ?? null}
            disabled={!preferences.data || save.isPending}
            onValueChange={(value) => {
              if (value === "agent" || value === "thread") {
                save.mutate({ messageListEmphasis: value });
              }
            }}
          >
            <SelectTrigger aria-label="消息列表突出显示">
              <SelectValue>
                {emphasis
                  ? emphasis === "agent"
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
                    ? "员工名字"
                    : "对话标题"
                  : "正在加载…"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="thread">对话标题</SelectItem>
              <SelectItem value="agent">员工名字</SelectItem>
=======
                    ? "Bot name"
                    : "Conversation title"
                  : "Loading…"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="thread">Conversation title</SelectItem>
              <SelectItem value="agent">Bot name</SelectItem>
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
      {preferences.isError ? (
        <div className="px-3 pb-3">
          <p role="alert" className="text-sm text-destructive">
            {preferences.error.message}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void preferences.refetch()}
          >
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
            重试
=======
            Try again
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
          </Button>
        </div>
      ) : null}
      {save.isError ? (
        <p role="alert" className="px-3 pb-3 text-sm text-destructive">
          {save.error.message}
        </p>
      ) : null}
      {save.isPending ? (
        <p role="status" className="px-3 text-sm text-muted-foreground">
          正在保存…
        </p>
      ) : null}
      {emphasis ? (
        <div className="flex justify-center px-6 pt-3 pb-6">
          <figure
            aria-label="消息列表预览"
            className="flex h-16 w-full max-w-xs items-center rounded-lg border border-border bg-sidebar px-3"
          >
            <ChannelItemContent
              participantIds={["message-list-preview"]}
              name="我的分身"
              title="规划下周"
              lastMessageAt="2小时"
              emphasis={emphasis}
            />
          </figure>
        </div>
      ) : null}
    </PageRows>
  );
}
