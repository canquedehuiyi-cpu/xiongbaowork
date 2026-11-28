import {
  IconChevronRight,
  IconCreditCard,
  IconInfoCircle,
  IconMoon,
  IconRocket,
  IconScale,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import React from "react";
import { PageRows, PageShell } from "@/components/layout/page-shell";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { NameRow } from "@/components/settings/profile";
import { SettingsSection } from "@/components/settings/settings-section";
import { StandingInstructionsRow } from "@/components/settings/standing-instructions";
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
import { planSummaryQueryOptions } from "@/lib/quota/queries";
import { useSettingsAudience } from "@/lib/settings/audience";
import { useAnchorScroll } from "@/lib/settings/use-anchor-scroll";
import { useSetupToFix } from "@/lib/setup/queries";
import { SkinPicker } from "@/skins/skin-picker";
import { APP_VERSION } from "./about";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();
  const audience = useSettingsAudience();
  useAnchorScroll(audience.ready);

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
      title="账户与外观"
    >
      {/*
       * What XiongBao and every Bot know of the person, first: their name and how they want things done. Both are free
       * text, so both are a summary that opens a dialog.
       */}
      <SettingsSection id="about-you" title="关于你">
        <PageRows>
          <NameRow />
          <Separator />
          <StandingInstructionsRow />
        </PageRows>
      </SettingsSection>
      <SettingsSection id="appearance" title="外观">
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
                data-setting-key="appearance.theme"
                checked={dark}
                onCheckedChange={setDark}
              />
            </ItemActions>
          </Item>
          <Separator />
          <SkinPicker />
        </PageRows>
        <MessageListPreference />
      </SettingsSection>
      {/*
       * Drawn from the same registry the listeners match against, so this list is what the keys
       * actually do rather than what somebody remembered they did. Read-only on purpose: these
       * are not rebindable, and a row with nothing to click says so by having nothing to click.
       */}
      <SettingsSection id="hotkeys" title="键盘快捷键">
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
      </SettingsSection>
      <SettingsSection id="plan" title="套餐与用量">
        <PageRows>
          <PlanRow />
        </PageRows>
      </SettingsSection>
      <SettingsSection id="about" title="关于">
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconInfoCircle />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>版本</ItemTitle>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {APP_VERSION}
              </span>
            </ItemActions>
          </Item>
          <Separator />
          <Item render={<Link to="/settings/about" />} size="sm">
            <ItemMedia variant="icon">
              <IconScale />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>开源软件声明</ItemTitle>
              <ItemDescription>本产品使用的开源软件及其许可。</ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          {audience.maySetUp ? (
            <>
              <Separator />
              <SetupRow />
            </>
          ) : null}
        </PageRows>
      </SettingsSection>
    </PageShell>
  );
}

/** 一行：当前套餐名和本月任务数；套餐页本身（含切换套餐）在子页里。 */
function PlanRow() {
  const plan = useQuery(planSummaryQueryOptions());
  const tasks = plan.data?.usage?.tasks;
  const summary =
    tasks === undefined
      ? plan.isError
        ? "读不到套餐与用量。"
        : "正在读取…"
      : `${plan.data?.plan?.name ?? "还没有订阅"} · 本月 ${tasks} 个任务`;
  return (
    <Item render={<Link to="/settings/plans" />} size="sm">
      <ItemMedia variant="icon">
        <IconCreditCard />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>套餐与用量</ItemTitle>
        <ItemDescription>{summary}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/**
 * 部署设置的入口。过渡期：所有 `maySetUp` 的人都显示，团队管理员也有；Task 27 按 §5.3.1 收窄，
 * 团队管理员的入口改放团队管理页。
 */
function SetupRow() {
  const toFix = useSetupToFix();
  return (
    <Item render={<Link to="/settings/setup" />} size="sm">
      <ItemMedia variant="icon">
        <IconRocket />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>部署设置</ItemTitle>
        <ItemDescription>
          {toFix > 0 ? `${toFix} 项待设置` : "都已就绪"}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}
