import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { isBrokeredProvenance } from "@/lib/plugins/brokered";
import {
  appKeyOf,
  connectionsQueryOptions,
  type PluginServer,
  type PluginsPage,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { useZh } from "@/lib/translations/queries";
import { cn } from "@/lib/utils";
import {
  CARD_FACE,
  CardGrid,
  grantedSentence,
  NoMatch,
  QueryState,
  ResourceSymbol,
  TabEmpty,
  TabHeader,
  TabSearch,
  Tag,
} from "./resource-kit";

/*
 * ── Stories E1/E4 (D08-7): connectors, and the card every capability tab draws. ──
 *
 * 连接器原来是能力与资源的一个页签，M5b 起放在「连接」页（`/connections`）的「员工可用的连接器」一区，那一页
 * import 这里的 `ConnectorsTab`；`/resources?tab=connectors` 重定向到那里。所以这里不再放去「已连接的账号」的
 * 按钮——它就在同一页上。
 *
 * Connectors are drawn from the one `/api/plugins` read, so that request failing is the tab's alert;
 * the read beside it (what you connected) only takes away the detail it adds. The skills tab, which
 * reads the same endpoint, is the full skills screen in `components/skills/skills-screen.tsx`.
 */

/**
 * A row of a tab, drawn as a card in the tab's grid — docs/design/ios-studio's card: a hairline
 * graphite face at a 13px radius, the icon plate and title on the first line, two lines of
 * description, and the quiet meta along the bottom. `Item` keeps the slots the tests read.
 */
export function ResourceCard({
  title,
  description,
  meta,
  media,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  media?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className="flex min-w-0">
      <Item
        className={cn(
          CARD_FACE,
          "h-full min-h-[104px] flex-nowrap items-start gap-[8px] px-[11px] py-[10px] dark:border-border",
        )}
        variant="outline"
      >
        {media ? <ItemMedia>{media}</ItemMedia> : null}
        <ItemContent className="min-w-0 gap-[4px] self-stretch">
          <ItemTitle className="flex-wrap font-bold text-[13px] leading-[20px]">
            {title}
          </ItemTitle>
          {description ? (
            <ItemDescription className="text-[12px] leading-[1.6]">
              {description}
            </ItemDescription>
          ) : null}
          {meta ? (
            <span className="mt-auto pt-[6px] text-[11px] text-faint">
              {meta}
            </span>
          ) : null}
        </ItemContent>
        {actions ? (
          <ItemActions className="shrink-0">{actions}</ItemActions>
        ) : null}
      </Item>
    </li>
  );
}

const textMatch = (query: string, ...fields: (string | null | undefined)[]) => {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return true;
  return fields.join(" ").toLocaleLowerCase().includes(term);
};

export { textMatch };

/** The badge tone for a connector's state: connected is the brighter plate, a gap the red one. */
function accountTone(state: string): "muted" | "positive" | "warning" {
  if (state === "你已连接" || state === "已接入") return "positive";
  if (state === "未连接" || state === "没有凭据") return "warning";
  return "muted";
}

/**
 * Whether an app answers as whoever is asking, so a Waker reaches it only once this person connected
 * their own account: a catalogue `user-oauth` vendor, or a brokered app that needs an account. The
 * same rule the assembly page and the connected-accounts page decide by.
 */
export function connectsPerPerson(
  server: PluginServer,
  page: PluginsPage,
): boolean {
  if (isBrokeredProvenance(server.provenance))
    return server.authScheme !== "NO_AUTH";
  // The catalogue key, not the row id: a curated connector is the team's row `team:<key>`.
  const key = appKeyOf(server);
  return page.catalogue.some(
    (entry) => entry.key === key && entry.auth === "user-oauth",
  );
}

/**
 * Story E1's connectors, with where each one stands.
 *
 * 已授予 N 位员工 counts Wakers, not grants: the union of every tool's `grantedTo`, so a Waker that
 * holds three of a connector's tools is one employee. For an app reached as the person asking, the
 * card also says whether THIS person connected their account — a granted tool on an unconnected
 * account reaches nothing. That comes from `/api/plugins/connections`; when it cannot be read the
 * card says so rather than guessing 未连接.
 */
export function ConnectorsTab({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (value: string) => void;
}) {
  const zh = useZh();
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const servers = plugins.data?.servers ?? [];
  const visible = servers.filter((server) =>
    textMatch(query, server.title, server.summary, server.vendor),
  );
  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );

  const accountState = (server: PluginServer): string => {
    if (!plugins.data || !connectsPerPerson(server, plugins.data))
      return server.hasCredential ? "已接入" : "没有凭据";
    if (connections.isPending) return "正在读取你的连接…";
    if (connections.error) return "读不到你的连接";
    return connected.has(server.id) ? "你已连接" : "未连接";
  };

  return (
    <>
      <TabHeader
        description="员工干活时可以碰到的系统。授予是管理员的动作，所以这里列出有什么、授予了几位员工、你自己的账号连上没有，以及在哪里决定。"
        search={
          <TabSearch label="搜索连接器" onChange={onQuery} value={query} />
        }
      />
      <QueryState label="读不到连接器" query={plugins}>
        {servers.length === 0 ? (
          <TabEmpty
            description="管理员在插件页里添加连接器之后，它们会出现在这里。"
            title="还没有连接器"
          />
        ) : visible.length === 0 ? (
          <NoMatch onClear={() => onQuery("")} title="没有匹配的连接器" />
        ) : (
          <CardGrid className="mt-[12px]" label="连接器列表">
            {visible.map((server) => (
              <ResourceCard
                actions={
                  <Tag tone={accountTone(accountState(server))}>
                    {accountState(server)}
                  </Tag>
                }
                description={zh(server.summary)}
                key={server.id}
                media={
                  <ResourceSymbol>
                    <PluginLogo logo={server.logo} />
                  </ResourceSymbol>
                }
                meta={grantedSentence(
                  new Set(server.tools.flatMap((tool) => tool.grantedTo)).size,
                )}
                title={zh(server.title)}
              />
            ))}
          </CardGrid>
        )}
      </QueryState>
      <p className="mt-[14px] text-[12px] text-muted-foreground">
        授予在
        <Link
          className="text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
          to="/admin/plugins"
        >
          管理员的插件页
        </Link>
        里管理；你自己的账号在
        <Link
          className="text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
          search={{}}
          to="/connections"
        >
          连接
        </Link>
        页上连接。
      </p>
    </>
  );
}
