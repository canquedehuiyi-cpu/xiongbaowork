import {
  appKeyOf,
  type CatalogueItem,
  type InstallListing,
  listedRefs,
  type PluginConnections,
  type PluginServer,
  type PluginsPage,
} from "./queries";

/**
 * The 插件 tab of 能力与资源 as cards (parity plan F4): one shape over the two lists `/api/plugins`
 * already carries, so the market and the person's own view are drawn by the same card.
 *
 * Nothing here is new data. 插件市场 is the reviewed catalogue — the plugins this deployment can
 * add — and 我的插件 is the servers it has added (the catalogue's that were installed, plus the ones
 * added by URL or through the broker, which the catalogue never lists). The category is derived from
 * how an app is reached, because neither a catalogue entry nor a server carries a category of its
 * own; Composio's directory does, but that is an administrator's separate read.
 */

export type PluginCategory =
  | "personal"
  | "team"
  | "builtin"
  | "open"
  | "composio"
  | "custom";

export const PLUGIN_CATEGORIES: readonly {
  id: PluginCategory;
  label: string;
}[] = [
  { id: "personal", label: "个人账号" },
  { id: "team", label: "团队凭据" },
  { id: "builtin", label: "内置能力" },
  { id: "open", label: "免凭据" },
  { id: "composio", label: "Composio 应用" },
  { id: "custom", label: "自定义" },
];

export function isPluginCategory(value: unknown): value is PluginCategory {
  return PLUGIN_CATEGORIES.some((category) => category.id === value);
}

export type PluginCard = {
  /** The name grants, listings and the admin page call it by. */
  key: string;
  title: string;
  vendor: string;
  summary: string;
  docsUrl: string;
  logo: string | null;
  category: PluginCategory;
  catalogue: CatalogueItem | null;
  /** The deployment's row, when the plugin is installed. */
  server: PluginServer | null;
  /** An administrator listed it (上架) for owners to install on their own Wakers. */
  listed: boolean;
  /** Whether a Waker reaches it only once the person asking connected their own account. */
  perPerson: boolean;
};

const AUTH_CATEGORY: Record<CatalogueItem["auth"], PluginCategory> = {
  "user-oauth": "personal",
  "deployment-bearer": "team",
  builtin: "builtin",
  none: "open",
};

function serverFor(
  entry: CatalogueItem,
  servers: PluginServer[],
): PluginServer | null {
  return (
    servers.find(
      (server) => server.id === entry.key || appKeyOf(server) === entry.key,
    ) ?? null
  );
}

function catalogueFor(
  server: PluginServer,
  catalogue: CatalogueItem[],
): CatalogueItem | null {
  const key = appKeyOf(server);
  return (
    catalogue.find((entry) => entry.key === server.id || entry.key === key) ??
    null
  );
}

function card(
  catalogue: CatalogueItem | null,
  server: PluginServer | null,
  listed: Set<string>,
): PluginCard {
  const key = catalogue?.key ?? (server ? appKeyOf(server) : "");
  const category: PluginCategory = catalogue
    ? AUTH_CATEGORY[catalogue.auth]
    : server?.provenance === "composio"
      ? "composio"
      : "custom";
  const perPerson = catalogue
    ? catalogue.auth === "user-oauth"
    : server?.provenance === "composio" && server.authScheme !== "NO_AUTH";
  return {
    key,
    title: server?.title ?? catalogue?.title ?? key,
    vendor: server?.vendor || catalogue?.vendor || "",
    summary: server?.summary || catalogue?.summary || "",
    docsUrl: server?.docsUrl || catalogue?.docsUrl || "",
    logo: server?.logo ?? null,
    category,
    catalogue,
    server,
    listed: listed.has(key) || (server ? listed.has(server.id) : false),
    perPerson,
  };
}

/** 插件市场: every reviewed catalogue entry, installed or not, in the catalogue's order. */
export function marketCards(
  page: PluginsPage,
  listings: InstallListing[] | undefined,
): PluginCard[] {
  const listed = listedRefs(listings, "mcp");
  return page.catalogue.map((entry) =>
    card(entry, serverFor(entry, page.servers), listed),
  );
}

/** 我的插件: every server this deployment installed, in the order the server lists them. */
export function installedCards(
  page: PluginsPage,
  listings: InstallListing[] | undefined,
): PluginCard[] {
  const listed = listedRefs(listings, "mcp");
  return page.servers.map((server) =>
    card(catalogueFor(server, page.catalogue), server, listed),
  );
}

/** Distinct Wakers holding any of a server's tools: three tools on one Waker is one employee. */
export function grantedWakers(server: PluginServer | null): number {
  if (!server) return 0;
  return new Set(server.tools.flatMap((tool) => tool.grantedTo)).size;
}

/**
 * The key `/settings/connected-accounts/$key` opens a per-person app under: the catalogue key for a
 * reviewed app, the server's own id for a brokered one — the same keys that page lists them by.
 */
export function accountKeyOf(card: PluginCard): string {
  return card.catalogue ? card.catalogue.key : (card.server?.id ?? card.key);
}

/** The key the administrator's plugin page opens this plugin under. */
export function adminKeyOf(card: PluginCard): string {
  return card.server?.id ?? card.key;
}

export type PluginStatus =
  | { kind: "not-installed"; label: "未安装" }
  | { kind: "connected"; label: "已授权" }
  | { kind: "unconnected"; label: "待授权" }
  | { kind: "unknown"; label: string }
  | { kind: "ready"; label: "已安装" }
  | { kind: "no-credential"; label: "缺少凭据" }
  | { kind: "failing"; label: "连接异常" };

/**
 * Where one plugin stands for the person looking.
 *
 * A per-person app is asked about THIS person's account, and when the connections read is pending or
 * failed the card says so rather than guessing 待授权 — a failed read is not an answer. Any other
 * installed plugin answers the same for everybody: installed with what it needs, or without.
 */
export function pluginStatus(
  card: PluginCard,
  connections: {
    data: PluginConnections | undefined;
    isPending: boolean;
    error: unknown;
  },
): PluginStatus {
  const server = card.server;
  if (!server) return { kind: "not-installed", label: "未安装" };
  if (server.lastError) return { kind: "failing", label: "连接异常" };
  if (card.perPerson) {
    if (connections.error) return { kind: "unknown", label: "读不到授权状态" };
    if (connections.isPending || !connections.data)
      return { kind: "unknown", label: "正在读取授权…" };
    const ids = new Set(
      connections.data.connections.map((row) => row.serverId),
    );
    return ids.has(server.id) || ids.has(card.key)
      ? { kind: "connected", label: "已授权" }
      : { kind: "unconnected", label: "待授权" };
  }
  if (card.catalogue?.auth === "deployment-bearer" && !server.hasCredential)
    return { kind: "no-credential", label: "缺少凭据" };
  return { kind: "ready", label: "已安装" };
}

/** Whether a card matches a search term, by its name, vendor and description. */
export function matchesSearch(card: PluginCard, query: string): boolean {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return true;
  return `${card.title} ${card.vendor} ${card.summary}`
    .toLocaleLowerCase()
    .includes(term);
}

export const PLUGIN_PAGE_SIZE = 12;
