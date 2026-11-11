import { IconMoon } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { AiModelSection } from "@/components/settings/ai-connection";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { NameRow } from "@/components/settings/profile";
import { StandingInstructionsRow } from "@/components/settings/standing-instructions";
import { UsageDataSection } from "@/components/settings/usage-data";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { formatHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";
import { SkinPicker } from "@/skins/skin-picker";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   *
   * Connected accounts used to be a section below. It is its own screen now: a connector can need
   * more from a person than one switch, and a section cannot grow a page's worth of that.
   */
  return (
    <PageShell
      width="workbench"
      description="你的名字、应用在你这里的外观，以及所有员工都会遵循的长期指令。消息列表偏好会随账号同步；主题只保存在这个浏览器里。"
      title="偏好设置"
    >
      {/*
       * What OpenBot and every Bot know of the person, first: their name and how they want things done. Both are free
       * text, so both are a summary that opens a dialog.
       */}
      <PageSection title="关于你">
        <PageRows>
          <NameRow />
          <Separator />
          <StandingInstructionsRow />
        </PageRows>
      </PageSection>
      {/* 只在熊宝桌面端出现：AI 连接由桌面端持有，并在它自己的窗口里修改。 */}
      <AiModelSection />
      {/* 只在熊宝桌面端出现：使用数据由桌面端发送，这个选择也由它保存。 */}
      <UsageDataSection />
      <PageSection title="外观">
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconMoon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>深色主题</ItemTitle>
              <ItemDescription>在整个应用里使用深色外观。</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="深色主题"
                checked={dark}
                onCheckedChange={setDark}
              />
            </ItemActions>
          </Item>
          <Separator />
          <SkinPicker />
        </PageRows>
        <MessageListPreference />
      </PageSection>
      {/* 我的设备（M5b）搬到了设置里自己的分区 /settings/devices。 */}
      {/*
       * Drawn from the same registry the listeners match against, so this list is what the keys
       * actually do rather than what somebody remembered they did. Read-only on purpose: these
       * are not rebindable, and a row with nothing to click says so by having nothing to click.
       */}
      <PageSection title="键盘快捷键">
        <PageRows>
          {HOTKEYS.map((hotkey, index) => (
            <React.Fragment key={hotkey.id}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{hotkey.label}</ItemTitle>
                  <ItemDescription>{hotkey.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="flex gap-1">
                    {formatHotkey(hotkey.combo).map((part) => (
                      <kbd
                        className="rounded-md border bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground"
                        key={part}
                      >
                        {part}
                      </kbd>
                    ))}
                  </span>
                </ItemActions>
              </Item>
              {index !== HOTKEYS.length - 1 && <Separator />}
            </React.Fragment>
          ))}
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
