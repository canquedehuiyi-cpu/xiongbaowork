import { IconChevronRight, IconSparkles } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { describeAiConnection } from "@/lib/desktop/ai-connection";
import { changeAiConnectionMutationOptions } from "@/lib/desktop/mutations";
import {
  type DesktopAiConnection,
  desktopAiConnectionQueryOptions,
} from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";

/**
 * Settings → General's AI model: which AI provider OpenBot Desktop uses and how it signs in, with
 * Change, which opens the desktop app's own AI screen. Never the key itself.
 *
 * Only inside OpenBot Desktop, which holds the connection. A self-hosted OpenBot reads its model
 * from its own configuration and has nothing here to change, so the section isn't drawn there. An
 * older desktop app that can't say draws nothing either.
 */
export function AiModelSection() {
  const connection = useQuery(desktopAiConnectionQueryOptions());
  if (desktopShell() === null || !connection.data) return null;
  return (
    <PageSection
      description="选择员工用哪家 AI 提供方，以及熊宝怎样登录它。"
      title="AI 模型"
    >
      <PageRows>
        <AiConnectionRow connection={connection.data} />
      </PageRows>
    </PageSection>
  );
}

function AiConnectionRow({ connection }: { connection: DesktopAiConnection }) {
  const [open, setOpen] = useState(false);
  const change = useMutation(changeAiConnectionMutationOptions());
  const described = describeAiConnection(connection);
  // On success the desktop app is stopping OpenBot, and this page goes with it.
  const stopping = change.isPending || change.isSuccess;
  return (
    <>
      <Item
        render={<button onClick={() => setOpen(true)} type="button" />}
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconSparkles />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{described?.provider ?? "还没有选择"}</ItemTitle>
          <ItemDescription>
            {described?.summary ?? "选择员工使用的 AI。"}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>AI 连接</DialogTitle>
            <DialogDescription>
              {described
                ? `你的员工使用 ${described.provider}。你的密钥或登录信息只保存在这台电脑上。`
                : "你的员工还没有 AI 提供方。"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
            {described && (
              <ItemGroup className="gap-1">
                {described.details.map((detail) => (
                  <Item
                    key={detail.label}
                    role="listitem"
                    size="xs"
                    variant="muted"
                  >
                    <ItemContent>
                      <ItemTitle className="font-normal text-muted-foreground">
                        {detail.label}
                      </ItemTitle>
                    </ItemContent>
                    <ItemActions className="min-w-0">
                      <span className="truncate font-medium">
                        {detail.value}
                      </span>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            )}
            <p className="text-muted-foreground">
              要更换的话，熊宝会先停下并打开设置窗口，按你在那里选的连接重新启动。
            </p>
            {change.error ? (
              <p className="text-destructive" role="alert">
                没能打开设置窗口，请再试一次。
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
              取消
            </Button>
            <Button
              disabled={stopping}
              onClick={() => change.mutate()}
              size="sm"
            >
              {stopping ? "正在停止熊宝…" : "更换 AI 连接"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
