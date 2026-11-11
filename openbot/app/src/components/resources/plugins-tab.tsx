import { IconExternalLink, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { SearchBox } from "@/components/layout/search-box";
import { SegmentedTabs } from "@/components/layout/segmented-tabs";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  accountKeyOf,
  adminKeyOf,
  grantedWakers,
  installedCards,
  isPluginCategory,
  marketCards,
  matchesSearch,
  PLUGIN_CATEGORIES,
  PLUGIN_PAGE_SIZE,
  type PluginCard,
  type PluginCategory,
  type PluginStatus,
  pluginStatus,
} from "@/lib/plugins/market";
import {
  connectionsQueryOptions,
  installListingsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { useZh } from "@/lib/translations/queries";
import { cn } from "@/lib/utils";
import {
  CARD_FACE,
  grantedSentence,
  NoMatch,
  Pager,
  QueryState,
  ResourceSymbol,
  SectionHead,
  TabEmpty,
  Tag,
} from "./resource-kit";

export type PluginView = "market" | "mine";

export type PluginsSearch = {
  view?: PluginView;
  category?: string;
  page?: number;
  q?: string;
};

/**
 * 能力与资源 › 插件 (parity plan F4; drawn to docs/design/ios-studio, 05-能力与资源.png): the pill
 * switch 插件市场 / 我的插件 with 管理插件 on its right, then a 155px category panel (the search on
 * top, each category's count right-aligned, the selected one marked by a red edge) beside the
 * category's heading with its count badge and a three-column card grid paged twenty at a time, and a
 * details sheet per card.
 *
 * Reads `/api/plugins` with the listings and this person's connections beside it; each of those two
 * only takes away the detail it adds. Installing is an administrator's write that needs a token or a
 * consent flow configured, so this tab never performs it: an administrator is sent to the plugin's own
 * admin page, anybody else is told installing is the administrator's. Authorising a per-person app is
 * the person's own account page, which is where that consent flow already lives.
 */
export function PluginsTab({
  search,
  onSearch,
}: {
  search: PluginsSearch;
  /** Patches the URL's search; `replace` for typing, so every keystroke is not a history entry. */
  onSearch: (patch: PluginsSearch, options?: { replace?: boolean }) => void;
}) {
  const plugins = useQuery(pluginsPageQueryOptions());
  const listings = useQuery(installListingsQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const isAdmin = me.data?.role === "admin";
  const [text, setText] = useState(search.q ?? "");
  const [opened, setOpened] = useState<PluginCard | null>(null);

  const view: PluginView = search.view ?? "market";
  const category: PluginCategory | null = isPluginCategory(search.category)
    ? search.category
    : null;

  const market = plugins.data ? marketCards(plugins.data, listings.data) : [];
  const mine = plugins.data ? installedCards(plugins.data, listings.data) : [];
  const scoped = view === "market" ? market : mine;
  const searched = scoped.filter((card) => matchesSearch(card, text));
  const shown = category
    ? searched.filter((card) => card.category === category)
    : searched;
  const pages = Math.max(1, Math.ceil(shown.length / PLUGIN_PAGE_SIZE));
  const page = Math.min(Math.max(1, search.page ?? 1), pages);
  const paged = shown.slice(
    (page - 1) * PLUGIN_PAGE_SIZE,
    page * PLUGIN_PAGE_SIZE,
  );
  const status = (card: PluginCard) => pluginStatus(card, connections);

  return (
    <>
      <div className="mt-[22px] mb-[9px] flex flex-wrap items-center justify-between gap-[10px]">
        <SegmentedTabs
          label="插件范围"
          onValueChange={(value) =>
            onSearch({ view: value, category: undefined, page: undefined })
          }
          tabs={[
            {
              value: "market",
              label: "插件市场",
              ...(plugins.data ? { count: market.length } : {}),
            },
            {
              value: "mine",
              label: "我的插件",
              ...(plugins.data ? { count: mine.length } : {}),
            },
          ]}
          value={view}
        />
        {isAdmin ? (
          <Button
            render={(props) => <Link to="/admin/plugins" {...props} />}
            variant="outline"
          >
            <IconSettings />
            管理插件
          </Button>
        ) : null}
      </div>
      <QueryState label="读不到插件" query={plugins}>
        {scoped.length === 0 ? (
          view === "market" ? (
            <TabEmpty
              description="这个版本审核过的插件会出现在插件市场里。"
              title="插件市场里还没有插件"
            />
          ) : (
            <TabEmpty
              description={
                isAdmin
                  ? "从插件市场选一个添加，或在插件管理里按地址添加。"
                  : "管理员添加插件之后，它们会出现在这里。"
              }
              title="还没有安装插件"
            />
          )
        ) : (
          <div className="grid grid-cols-1 gap-[12px] min-[791px]:grid-cols-[155px_minmax(0,1fr)]">
            <div
              className={cn(
                CARD_FACE,
                "flex flex-col gap-[6px] self-start px-[7px] py-[9px]",
              )}
              data-slot="plugin-rail"
            >
              <SearchBox
                className="h-[31px] w-full"
                label="搜索插件"
                onValueChange={(value) => {
                  setText(value);
                  onSearch(
                    { q: value || undefined, page: undefined },
                    { replace: true },
                  );
                }}
                placeholder="搜索插件"
                value={text}
              />
              <CategorySidebar
                cards={searched}
                onChange={(next) =>
                  onSearch({ category: next ?? undefined, page: undefined })
                }
                value={category}
              />
            </div>
            <div className="@container min-w-0">
              <SectionHead
                aside={<Tag>{shown.length} 个插件</Tag>}
                title={
                  category
                    ? (PLUGIN_CATEGORIES.find((row) => row.id === category)
                        ?.label ?? "全部分类")
                    : "全部分类"
                }
              />
              {shown.length === 0 ? (
                <NoMatch
                  onClear={() => {
                    setText("");
                    onSearch({
                      q: undefined,
                      category: undefined,
                      page: undefined,
                    });
                  }}
                  title="没有匹配的插件"
                />
              ) : (
                <>
                  <ul
                    aria-label="插件列表"
                    className="grid grid-cols-1 gap-[9px] @min-[400px]:grid-cols-2 @min-[600px]:grid-cols-3"
                  >
                    {paged.map((card) => (
                      <PluginCardView
                        card={card}
                        isAdmin={isAdmin}
                        key={`${card.key}:${card.server?.id ?? ""}`}
                        onOpen={() => setOpened(card)}
                        status={status(card)}
                      />
                    ))}
                  </ul>
                  <Pager
                    onPage={(next) => onSearch({ page: next })}
                    page={page}
                    pages={pages}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </QueryState>
      <PluginDetails
        card={opened}
        isAdmin={isAdmin}
        onClose={() => setOpened(null)}
        status={opened ? status(opened) : null}
      />
    </>
  );
}

/** The left column: 全部, then each category that has a plugin, with how many. */
function CategorySidebar({
  cards,
  value,
  onChange,
}: {
  cards: PluginCard[];
  value: PluginCategory | null;
  onChange: (value: PluginCategory | null) => void;
}) {
  const counts = new Map<PluginCategory, number>();
  for (const card of cards)
    counts.set(card.category, (counts.get(card.category) ?? 0) + 1);
  const rows: { id: PluginCategory | null; label: string; count: number }[] = [
    { id: null, label: "全部", count: cards.length },
    ...PLUGIN_CATEGORIES.filter(
      (category) => counts.has(category.id) || category.id === value,
    ).map((category) => ({
      id: category.id,
      label: category.label,
      count: counts.get(category.id) ?? 0,
    })),
  ];
  return (
    <nav
      aria-label="插件分类"
      // A column in the panel; a wrapping row of chips at 790px and under, as the reference folds it.
      className="flex flex-row flex-wrap gap-[4px] min-[791px]:flex-col min-[791px]:gap-[2px]"
    >
      {rows.map((row) => {
        const selected = row.id === value;
        return (
          <button
            aria-pressed={selected}
            className={cn(
              "flex min-h-[30px] items-center justify-between gap-[8px] rounded-[7px] px-[8px] py-[6px] text-left text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none",
              // The selected row: a 2px red edge on the left and a slightly lighter ground.
              selected
                ? "bg-foreground/[0.047] font-medium text-foreground shadow-[inset_2px_0_0_var(--signal)]"
                : "text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground",
            )}
            key={row.id ?? "all"}
            onClick={() => onChange(row.id)}
            type="button"
          >
            <span>{row.label}</span>
            <span
              className={cn(
                "tabular-nums",
                selected ? "text-foreground/90" : "text-faint",
              )}
            >
              {row.count}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function statusTone(status: PluginStatus): "muted" | "positive" | "warning" {
  if (status.kind === "connected" || status.kind === "ready") return "positive";
  if (
    status.kind === "unconnected" ||
    status.kind === "no-credential" ||
    status.kind === "failing"
  )
    return "warning";
  return "muted";
}

/**
 * The one action a card offers, by what this person may do with it.
 *
 * Not installed: an administrator goes to the plugin's admin page to add it; anybody else is shown a
 * disabled control saying installing is the administrator's, rather than a button that would fail.
 * Installed and reached per person: the person's own account page connects it. Installed otherwise:
 * an administrator manages it; there is nothing else for anybody to do.
 */
function PluginAction({
  card,
  status,
  isAdmin,
}: {
  card: PluginCard;
  status: PluginStatus;
  isAdmin: boolean;
}) {
  if (status.kind === "not-installed") {
    return isAdmin ? (
      <Button
        render={(props) => (
          <Link
            params={{ key: adminKeyOf(card) }}
            to="/admin/plugins/$key"
            {...props}
          />
        )}
        size="sm"
      >
        去安装
      </Button>
    ) : (
      <Button
        disabled
        size="sm"
        title="安装插件由管理员在插件管理里完成"
        variant="outline"
      >
        需管理员安装
      </Button>
    );
  }
  if (card.perPerson) {
    return (
      <Button
        render={(props) => (
          <Link
            params={{ key: accountKeyOf(card) }}
            to="/settings/connected-accounts/$key"
            {...props}
          />
        )}
        size="sm"
        variant={status.kind === "unconnected" ? "default" : "outline"}
      >
        {status.kind === "connected" ? "管理授权" : "去授权"}
      </Button>
    );
  }
  return isAdmin ? (
    <Button
      render={(props) => (
        <Link
          params={{ key: adminKeyOf(card) }}
          to="/admin/plugins/$key"
          {...props}
        />
      )}
      size="sm"
      variant="outline"
    >
      管理
    </Button>
  ) : null;
}

function PluginCardView({
  card,
  status,
  isAdmin,
  onOpen,
}: {
  card: PluginCard;
  status: PluginStatus;
  isAdmin: boolean;
  onOpen: () => void;
}) {
  const zh = useZh();
  const titleId = `plugin-card-${card.key}-${card.server?.id ?? "entry"}`;
  return (
    /*
     * docs/design/ios-studio's card (13px radius): a 33px icon plate and the name, two lines of
     * description, and a footer of 「@vendor」 with a badge for where this plugin stands for the
     * person looking (未安装 / 已授权 / …; the words carry it, the badge's tone only echoes it).
     * The whole card opens the details; the one action it offers rises in its corner on hover or
     * focus (always, on a touch screen), and is in the details too.
     */
    <li
      aria-labelledby={titleId}
      className={cn(
        CARD_FACE,
        "group relative flex min-h-[126px] min-w-0 flex-col px-[11px] py-[10px] transition-colors hover:border-foreground/15 motion-reduce:transition-none",
      )}
    >
      <div className="flex min-w-0 items-center gap-[8px]">
        <ResourceSymbol>
          <PluginLogo logo={card.logo} />
        </ResourceSymbol>
        <span
          className="min-w-0 truncate font-bold text-[13px] leading-[20px]"
          data-slot="plugin-card-title"
          id={titleId}
        >
          {zh(card.title)}
        </span>
      </div>
      <p
        className="mt-[6px] mb-[8px] line-clamp-2 text-[12px] text-muted-foreground leading-[1.6]"
        data-slot="plugin-card-summary"
      >
        {zh(card.summary) || "这个插件没有提供说明。"}
      </p>
      <div
        className="mt-auto flex min-w-0 items-center gap-[5px] text-[11px] text-faint"
        data-slot="plugin-card-footer"
      >
        <span className="min-w-0 flex-1 truncate">
          {card.vendor ? `@${card.vendor}` : null}
        </span>
        {card.listed ? <Tag>可自助安装</Tag> : null}
        <Tag tone={statusTone(status)}>{status.label}</Tag>
      </div>
      <button
        className="absolute inset-0 rounded-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        onClick={onOpen}
        type="button"
      >
        <span className="sr-only">详情：{zh(card.title)}</span>
      </button>
      <div className="absolute top-[10px] right-[11px] z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100">
        <PluginAction card={card} isAdmin={isAdmin} status={status} />
      </div>
    </li>
  );
}

const AUTH_SENTENCE: Record<string, string> = {
  "user-oauth": "每个人连接自己的账号，员工以提问者的身份访问它。",
  "deployment-bearer": "管理员为整个部署保存一份凭据，所有人共用。",
  builtin: "部署内置的能力，不需要连接任何东西。",
  none: "不需要凭据。",
};

/** The details of one plugin, drawn from what the tab already read — no second request. */
function PluginDetails({
  card,
  status,
  isAdmin,
  onClose,
}: {
  card: PluginCard | null;
  status: PluginStatus | null;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const zh = useZh();
  const how = card?.catalogue
    ? AUTH_SENTENCE[card.catalogue.auth]
    : card?.server?.provenance === "composio"
      ? card.perPerson
        ? "通过熊宝连接，每个人连接自己的账号。"
        : "通过熊宝连接，不需要账号。"
      : "管理员按地址添加的插件。";
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={card !== null}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {card && status ? (
          <>
            <SheetHeader className="gap-[12px] border-border border-b pr-12 pb-[14px]">
              <div className="flex min-w-0 items-center gap-[10px]">
                <ResourceSymbol className="size-[40px] rounded-[11px]">
                  <PluginLogo logo={card.logo} />
                </ResourceSymbol>
                <div className="flex min-w-0 flex-col gap-[2px]">
                  <SheetTitle className="truncate font-bold text-[17px] tracking-[-0.02em]">
                    {zh(card.title)}
                  </SheetTitle>
                  <SheetDescription className="truncate text-[12px] text-faint">
                    {card.vendor ? `@${card.vendor}` : null}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-[6px]">
                <Tag tone={statusTone(status)}>{status.label}</Tag>
                {card.listed ? <Tag>可自助安装</Tag> : null}
              </div>
            </SheetHeader>
            <div className="flex flex-col gap-[14px] px-4 pt-[14px] pb-4 text-[13px] leading-[1.6]">
              {card.summary ? <p>{zh(card.summary)}</p> : null}
              {card.server?.lastError ? (
                <p
                  className="rounded-[9px] bg-signal-soft px-[10px] py-[7px] text-signal-ink"
                  role="note"
                >
                  {card.server.lastError}
                </p>
              ) : null}
              <p className="text-muted-foreground">{how}</p>
              {card.listed ? (
                <p className="text-muted-foreground">
                  管理员已上架：员工的主人可以在员工装配页里自己装上它。
                </p>
              ) : null}
              {card.server ? (
                <div className="flex flex-col gap-[8px]">
                  <div className="flex items-center justify-between gap-[10px]">
                    <h3 className="font-bold text-[14px]">工具</h3>
                    <span className="text-[12px] text-muted-foreground">
                      {grantedSentence(grantedWakers(card.server))}
                    </span>
                  </div>
                  {card.server.tools.length === 0 ? (
                    <p className="text-muted-foreground">
                      它目前没有提供任何工具。
                    </p>
                  ) : (
                    <ul
                      className={cn(
                        CARD_FACE,
                        "flex flex-col divide-y divide-border",
                      )}
                    >
                      {card.server.tools.map((tool) => (
                        <li
                          className="flex flex-col gap-[2px] px-[11px] py-[8px]"
                          key={tool.ref}
                        >
                          <span className="flex items-center gap-[8px] font-mono text-[12px]">
                            <span className="min-w-0 truncate">
                              {tool.name}
                            </span>
                            <Tag>
                              {tool.effect === "read" ? "只读" : "会修改"}
                            </Tag>
                          </span>
                          {tool.description ? (
                            <span className="text-[12px] text-muted-foreground">
                              {zh(tool.description)}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground">
                  还没有添加到这个部署，添加之后才能看到它提供的工具。
                </p>
              )}
              <div className="flex flex-wrap items-center gap-[7px] border-border border-t pt-[14px]">
                <PluginAction card={card} isAdmin={isAdmin} status={status} />
                {card.docsUrl ? (
                  <Button
                    render={(props) => (
                      <a
                        href={card.docsUrl}
                        rel="noreferrer"
                        target="_blank"
                        {...props}
                      />
                    )}
                    size="sm"
                    variant="ghost"
                  >
                    <IconExternalLink />
                    文档
                  </Button>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
