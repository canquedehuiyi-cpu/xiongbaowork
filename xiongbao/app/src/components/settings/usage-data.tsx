import { IconChartBar } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { shortName } from "@/lib/brand";
import { setUsageDataMutationOptions } from "@/lib/desktop/mutations";
import { desktopUsageDataQueryOptions } from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";

/** What OpenBot Desktop sends, and what it never does, in full. */
export const USAGE_DATA_DOC =
  "https://github.com/CopilotKit/OpenBot/blob/main/desktop/TELEMETRY.md";

/**
 * Settings → General's Share usage data: the opt-out that otherwise needs an environment variable,
 * as one switch. Off stops the desktop app's own usage data and the CLI's at once, and the server's
 * the next time OpenBot starts, which is what the row says.
 *
 * Only inside OpenBot Desktop, which sends this data and keeps the choice. A self-hosted OpenBot
 * sets its telemetry in its own configuration, so the section isn't drawn there. An older desktop
 * app that can't say draws nothing either.
 */
export function UsageDataSection() {
  const usageData = useQuery(desktopUsageDataQueryOptions());
  const queryClient = useQueryClient();
  const change = useMutation(setUsageDataMutationOptions(queryClient));
  if (desktopShell() === null || !usageData.data) return null;
  const { shared, offByEnvironment } = usageData.data;
  return (
    <PageSection title="隐私">
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconChartBar />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>共享使用数据</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {offByEnvironment
                ? `已在这台电脑上关闭，${shortName()}不发送任何使用数据。`
                : `${shortName()}会向 CopilotKit 发送使用数据，关联到你的 CopilotKit 账号。它从不发送你的对话、文件或密钥。改动在${shortName()}下次启动时生效。`}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href={USAGE_DATA_DOC}
                rel="noopener noreferrer"
                target="_blank"
              >
                {shortName()}会发送什么
              </a>
            </ItemDescription>
            {change.error ? (
              <p className="text-destructive text-sm" role="alert">
                没能修改这项设置，请再试一次。
              </p>
            ) : null}
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="共享使用数据"
              checked={shared}
              disabled={offByEnvironment || change.isPending}
              onCheckedChange={(share) => change.mutate(share)}
            />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
