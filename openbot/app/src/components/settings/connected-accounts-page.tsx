/*
 * M5b 第 0 步：从 `routes/_authed/settings/connected-accounts/index.tsx` 剪出的页面主体，原样保留，地址改成重定向（/settings/connected-accounts → /connections）。
 * 各组在新路由里接这个组件，再按新结构调整其中的链接与文案。
 */
import {
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconCheck,
  IconPlug,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { SearchBox } from "@/components/layout/search-box";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { LinkedAccountsSection } from "@/components/settings/linked-accounts";
import {
  linkedNotice,
  visibleLinkedNotice,
} from "@/components/settings/linked-notice";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { linkedAccountsQueryOptions } from "@/lib/identity/queries";
import { isBrokeredProvenance } from "@/lib/plugins/brokered";
import {
  appKeyOf,
  connectionsQueryOptions,
  type PluginServer,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * The services a Bot reads as you.
 *
 * Yours, not the deployment's. An administrator decides which vendors this deployment may reach at
 * all; this is the other half of that decision, and it is one nobody can make for you — there is no
 * endpoint for an administrator to connect an account on somebody's behalf. A Bot calling one of
 * these runs on your own grant, so it sees exactly what you can see and nothing else.
 */
// M4: 待接入 上游把已连接账户搬到了 /connections（_app/connections.*.tsx，含按应用的连接页、Composio 目录），并把这里改成重定向；fork 保留设置里的这一页（服务端 OAuth 仍回到 /settings/connected-accounts）

/** The same marks the admin connector list uses: these are the same vendors seen from your side. */
const MARKS: Record<string, React.ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
};

const markFor = (key: string) => MARKS[key] ?? IconPlug;

/**
 * The brokered apps this page lists, which is not every brokered row.
 *
 * Exported as a function rather than left inline in the render, for the reason `matchingApps` on the
 * Composio picker is: the rule is the thing worth pinning and pinning it needs no DOM, no router and
 * no query client. See its one clause below.
 */
export function brokeredAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) =>
      isBrokeredProvenance(server.provenance) &&
      server.authScheme !== "NO_AUTH",
  );
}

export function ConnectedAccountsPage({
  connected: arrivedOutcome,
  linked,
  onArrivalRead,
}: {
  connected?: string;
  linked?: string;
  /** Drops `?connected=` and `?linked=` from the address once read (the route did this itself). */
  onArrivalRead: () => void;
}) {
  /*
   * Both read once, then dropped from the URL together, so a refresh or a back-navigation does not
   * repeat news that is already over. One navigate for both: each replaces the whole search, so
   * stripping them one at a time could leave the other behind.
   */
  const [outcome] = React.useState(() => arrivedOutcome);
  const [arrival] = React.useState(() => linkedNotice(linked));
  /* The same cached list the linked accounts section reads, so a Disconnect there retracts a success here. */
  const links = useQuery(linkedAccountsQueryOptions());
  const notice = visibleLinkedNotice(arrival, links.data);
  React.useEffect(() => {
    if (linked !== undefined || arrivedOutcome !== undefined) {
      onArrivalRead();
    }
  }, [arrivedOutcome, linked, onArrivalRead]);
  const [search, setSearch] = React.useState("");
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );
  /*
   * Catalogue key to the row it was added as. Not the same string since G01-E: a curated connector
   * is the team's row `team:<catalogue key>`, and a connection names the row while the catalogue
   * names the key.
   */
  const added = new Map(
    (plugins.data?.servers ?? []).map((s) => [appKeyOf(s), s.id]),
  );

  /*
   * Only vendors reached as a person, and only ones an administrator has enabled.
   *
   * A vendor with a shared token has nothing for you to decide: it answers the same for everybody,
   * so listing it here would offer a choice you do not have. And a vendor nobody has enabled cannot
   * be connected at all, because there is no OAuth client to consent against.
   */
  const yours = (plugins.data?.catalogue ?? []).filter(
    (entry) => entry.auth === "user-oauth" && added.has(entry.key),
  );

  /*
   * Brokered apps belong here for the same reason the OAuth ones do: they answer as you.
   *
   * The filter above names the catalogue's `user-oauth` kind, which a brokered row cannot have
   * because it has no catalogue entry at all — so the one connector that is nothing but per-person
   * accounts was the one this page never listed.
   *
   * EXCEPT THE ONES THAT NEED NO ACCOUNT, WHICH IS THE SAME RULE THE `user-oauth` FILTER ABOVE IS.
   * That one keeps out a vendor with a shared token because it "has nothing for you to decide"; a
   * Composio `NO_AUTH` app has exactly as little, one layer further in. There is no account to make:
   * `/servers/:id/connect` refuses to create one and the call gate lets it through with no row, so
   * a row for it here can never turn green. What an admin enabling Hacker News put on every
   * person's page was a permanently grey "Not connected" that reads as an unfinished task, opening
   * a page that says the app needs no account and draws no button — the list and the page it opens
   * contradicting each other, with the list the more believable of the two.
   *
   * ASKED OF THE RECORDED SCHEME, which this read already carries and the detail route already
   * consumes. Anything that is not the vendor's `NO_AUTH` is an app somebody connects, an
   * unrecorded scheme included: a row whose column was never written is far likelier to be a key or
   * consent app, and dropping it here would hide a connection somebody does have.
   */
  const brokered = brokeredAccountsListedOn(plugins.data?.servers ?? []);
  const accounts = [
    ...yours.map((entry) => {
      const Mark = markFor(entry.key);
      return {
        key: entry.key,
        serverId: added.get(entry.key) ?? entry.key,
        title: entry.title,
        summary: entry.summary,
        mark: <Mark className="size-4" />,
      };
    }),
    ...brokered.map((server) => ({
      key: server.id,
      serverId: server.id,
      title: server.title,
      summary: server.summary || `连接你的 ${server.title} 账号。`,
      mark: <PluginLogo logo={server.logo} />,
    })),
  ];
  const query = search.trim().toLocaleLowerCase();
  const matching = accounts.filter((account) =>
    `${account.title} ${account.summary}`.toLocaleLowerCase().includes(query),
  );
  const connectedCount = accounts.filter((account) =>
    connected.has(account.serverId),
  ).length;
  const sections = [
    {
      title: "已连接",
      accounts: matching.filter((account) => connected.has(account.serverId)),
    },
    {
      title: "未连接",
      accounts: matching.filter((account) => !connected.has(account.serverId)),
    },
  ];

  return (
    <PageShell
      width="workbench"
      className="max-w-4xl @container"
      description="连接你的应用，让员工可以用它们干活。"
      title="已连接的账号"
    >
      {/*
       * Only the failure is worth saying. A success needs no sentence: the row it came back to now
       * reads "Connected", which is the same news told by the thing it is news about.
       */}
      {outcome === "failed" ? (
        <p className="text-destructive text-sm" role="alert">
          这个账号没能连接，什么都没有保存——请重试。
        </p>
      ) : null}
      {notice ? (
        notice.tone === "error" ? (
          <p className="text-destructive text-sm" role="alert">
            {notice.text}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            {notice.text}
          </p>
        )
      ) : null}
      {/*
       * BOTH READS DECIDE THIS, AND ONLY ONE OF THEM USED TO. The waits were already paired here;
       * the errors were not — this branch tested `plugins.error` alone, so a `/api/plugins` that
       * succeeded beside a `/api/plugins/connections` that failed left the `connected` set empty and
       * every row below asserting "Not connected", with no error text anywhere on the page. Somebody
       * holding Gmail through Composio and Drive through OAuth was shown both as unconnected and
       * clicked through to reconnect accounts they already had. The brokered rows make it worse than
       * it was before they existed, because a brokered row's entire content is the connection state.
       *
       * ONE SENTENCE FOR BOTH, because the two failures are one fact from where the reader stands:
       * this page could not be loaded, and what it would otherwise draw is not shown rather than
       * drawn wrong.
       */}
      {plugins.isPending || connections.isPending ? null : plugins.error ||
        connections.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          读不到你已连接的账号，所以这里什么都不列，免得列出错的。请刷新页面；如果一直这样，请告诉管理员。
        </p>
      ) : accounts.length === 0 ? (
        <PageSection>
          <PageEmpty>
            还没有可以连接的。管理员启用按提问者身份读取的连接器后，会出现在这里。
          </PageEmpty>
        </PageSection>
      ) : (
        <>
          <p className="mt-5 text-xs text-muted-foreground">
            已连接 {connectedCount} 个 · 共 {accounts.length} 个可用
          </p>
          <SearchBox
            className="mt-3 h-[36px] max-w-[420px]"
            label="搜索应用"
            onValueChange={setSearch}
            placeholder="搜索应用"
            value={search}
          />
          {matching.length === 0 ? (
            <p className="mt-8 text-sm text-muted-foreground" role="status">
              没有匹配“{search.trim()}”的应用。
            </p>
          ) : (
            sections
              .filter((section) => section.accounts.length > 0)
              .map((section) => (
                <section
                  className="mt-8"
                  key={section.title}
                  aria-label={section.title}
                >
                  <h2 className="mb-3 font-medium text-[12px] text-muted-foreground">
                    {section.title}
                    <span className="ml-1.5 font-mono text-faint">
                      {section.accounts.length}
                    </span>
                  </h2>
                  <div className="grid grid-cols-1 gap-[11px] @min-[36rem]:grid-cols-2">
                    {section.accounts.map((account) => (
                      <Item
                        key={account.key}
                        className="min-w-0 flex-nowrap gap-3 rounded-[14px] border border-border bg-card px-[13px] py-3 shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] hover:border-ring/50"
                        data-testid={`account-${account.key}`}
                        render={
                          <Link
                            params={{ key: account.key }}
                            to="/settings/connected-accounts/$key"
                          />
                        }
                        size="sm"
                      >
                        <RowMark className="size-9">{account.mark}</RowMark>
                        <ItemContent className="min-w-0 gap-0.5">
                          <ItemTitle className="block w-auto truncate">
                            {account.title}
                          </ItemTitle>
                          <ItemDescription
                            className="line-clamp-1 break-all text-xs"
                            title={account.summary}
                          >
                            {account.summary}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions className="shrink-0">
                          {connected.has(account.serverId) ? (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <IconCheck
                                aria-hidden="true"
                                className="size-3.5 text-emerald-600 dark:text-emerald-400"
                              />
                              已连接
                            </span>
                          ) : (
                            <span className="rounded-[9px] border border-border bg-muted px-3 py-1 font-medium text-xs">
                              连接
                            </span>
                          )}
                        </ItemActions>
                      </Item>
                    ))}
                  </div>
                </section>
              ))
          )}
        </>
      )}
      <LinkedAccountsSection />
    </PageShell>
  );
}
