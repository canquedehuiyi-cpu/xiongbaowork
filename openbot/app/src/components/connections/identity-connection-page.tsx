import {
  IconBrandGithub,
  IconBrandSlack,
  IconChevronRight,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { GithubSources } from "@/components/settings/github-sources";
import {
  type LinkableProvider,
  LinkedAccountSection,
  linkableProviderTitle,
} from "@/components/settings/linked-accounts";
import {
  linkedNotice,
  visibleLinkedNotice,
} from "@/components/settings/linked-notice";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { IDENTITY_SUMMARIES, isBrokeredGithub } from "@/lib/connections/rows";
import { linkedAccountsQueryOptions } from "@/lib/identity/queries";
import {
  appKeyOf,
  connectionsQueryOptions,
  personalConnections,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * GitHub's or Slack's page under Connections: the person's own account there, and for GitHub what
 * hangs off it.
 *
 * These used to be a "Linked accounts" section and a "GitHub events" section on the Connections
 * page itself, beside the apps, so a person had to know a link was a different kind of thing from an
 * app before they could find it. Now each is a row like any app, and this is the row's page.
 *
 * `linked` is what the GitHub callback sends back, `?linked=github` and its failures. It is said
 * once and then dropped from the address, so a reload does not repeat the news.
 */
export function IdentityConnectionPage({
  linked,
  provider,
}: {
  linked: string | undefined;
  provider: LinkableProvider;
}) {
  const title = linkableProviderTitle(provider);
  const [arrival] = useState(() => linkedNotice(linked));
  const links = useQuery(linkedAccountsQueryOptions());
  const notice = visibleLinkedNotice(arrival, links.data);
  const navigate = useNavigate();
  useEffect(() => {
    if (linked !== undefined) {
      navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => {
          const { linked: _linked, ...rest } = previous;
          return rest;
        },
        replace: true,
      });
    }
  }, [linked, navigate]);

  return (
    <PageShell
      backButton={{ label: "全部连接", linkProps: { to: "/connections" } }}
      description={IDENTITY_SUMMARIES[provider]}
      title={title}
    >
      {notice ? (
        <p
          className={
            notice.tone === "error"
              ? "mt-4 text-destructive text-sm"
              : "mt-4 text-muted-foreground text-sm"
          }
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      ) : null}
      <LinkedAccountSection provider={provider} />
      {provider === "github" ? <GithubSources /> : null}
      <IdentityAppTools provider={provider} />
    </PageShell>
  );
}

/**
 * The app of the same name, where one is enabled: a brokered GitHub app, or this fork's catalogue
 * `github` / `slack` app reached as the person asking. It is a separate connection — tools that read
 * (and for a brokered GitHub, change) things as you — and this page is the way to it from the
 * account link.
 */
function IdentityAppTools({ provider }: { provider: "github" | "slack" }) {
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const brokered =
    provider === "github" && plugins.data?.composioConfigured
      ? plugins.data.servers.find(
          (server) =>
            isBrokeredGithub(server) && server.accountMode !== "shared",
        )
      : undefined;
  const catalogued = plugins.data?.servers.find(
    (server) => appKeyOf(server) === provider,
  );
  const app = brokered ?? catalogued;
  if (!app) return null;
  const Icon = provider === "github" ? IconBrandGithub : IconBrandSlack;
  const connected = personalConnections(
    connections.data?.connections ?? [],
  ).some((row) => row.serverId === app.id);
  return (
    <PageSection
      description={
        provider === "github"
          ? "让你的员工以你的身份使用你的仓库。它和上面的账号关联是分开连接的。"
          : "让你的员工以你的身份读取 Slack。它和上面的账号关联是分开连接的。"
      }
      title="工具"
    >
      <PageRows>
        <Item
          render={
            <Link
              params={{ key: brokered ? app.id : provider }}
              to="/connections/$key"
            />
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <Icon />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{app.title}</ItemTitle>
            <ItemDescription>{connected ? "已连接" : "未连接"}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
