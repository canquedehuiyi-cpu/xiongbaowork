import { IconRadar } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import {
  deploymentCapabilitiesQueryOptions,
  offersMemory,
} from "@/lib/deployment/queries";
import { proactiveAllowedQueryOptions } from "@/lib/proactive";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";

/**
 * The person's own switch for every one of their Bots' check-ins at once. Off stops every Bot's
 * background checks for them before any model call; each Bot's own setting is kept, so turning this
 * back on restores them as they were.
 *
 * When an admin turned check-ins off for this person, the switch is off and cannot be changed, and
 * says who turned it off. Their own choice is kept underneath for when the admin turns it back on.
 */
export function CheckInsSection() {
  const preferences = useUserPreferences();
  const allowed = useQuery(proactiveAllowedQueryOptions());
  // Each Bot's own check-ins are on its Memory page, or on What it can do where there is no memory.
  const botPage = offersMemory(
    useQuery(deploymentCapabilitiesQueryOptions()).data,
  )
    ? "记忆"
    : "能力";
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, preferences.userId),
  );
  // The switch follows the press while the save is out, and the stored answer after.
  const chosen =
    (save.isPending ? save.variables?.proactive : undefined) ??
    preferences.data?.proactive;
  const byAdmin = allowed.data === false;
  const on = chosen === "on" && !byAdmin;
  return (
    <PageSection
      description="员工会查看它们能读取的应用，有需要你处理的事就告诉你，最多每小时一次。没经过你同意，它们不会动手。"
      title="主动巡检"
    >
      {preferences.isPending ? null : preferences.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到你的主动巡检设置。请刷新页面。
        </p>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconRadar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>你的所有员工</ItemTitle>
              <ItemDescription>
                {byAdmin
                  ? "已被管理员关闭。"
                  : on
                    ? `已开启。每位员工自己的巡检设置在它的「${botPage}」页。`
                    : "已关闭。你的员工都不会为你巡检。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="为你的所有员工开启主动巡检"
                checked={on}
                disabled={byAdmin || save.isPending}
                onCheckedChange={(next) =>
                  save.mutate({ proactive: next ? "on" : "off" })
                }
              />
            </ItemActions>
          </Item>
        </PageRows>
      )}
      {save.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {save.error.message}
        </p>
      ) : null}
    </PageSection>
  );
}
