import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { MyDevices } from "@/components/settings/my-devices";
import { StandingInstructions } from "@/components/settings/standing-instructions";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { formatHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";

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
      description="应用在你这里的外观和行为。消息列表偏好会随账号同步；主题只保存在这个浏览器里。"
      title="偏好设置"
    >
      <PageSection title="通用">
        <PageRows>
          <Item size="sm">
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
        </PageRows>
        <MessageListPreference />
      </PageSection>
      {/*
       * Above the shortcuts and below the appearance preferences, because it is the only thing on this
       * screen that changes what a coworker says rather than what this browser looks like.
       */}
      <StandingInstructions />
      {/*
       * The one section here that is not about this account's own settings. A machine is paired once
       * and then runs unattended, so it belongs with the other things a person configures and then
       * leaves alone — and pairing needs the person signed in, which is what this screen already is.
       */}
      <MyDevices />
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
