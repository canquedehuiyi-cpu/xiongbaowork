/**
 * Where an old `/agents` link goes now that the roster and each Bot's page replaced it.
 *
 * Old links are not only bookmarks: the model was told a new Bot's profile is at
 * `/agents?agent=<id>`, and that sentence is in conversations people still scroll back through.
 */
export function legacyAgentsTarget(search: { new?: boolean; agent?: string }) {
  if (search.new === true) {
    return { to: "/bots", search: { new: true }, replace: true } as const;
  }
  if (search.agent) {
    return {
      to: "/bots/$agentId",
      params: { agentId: search.agent },
      replace: true,
    } as const;
  }
  return { to: "/bots", replace: true } as const;
}

/**
 * The pages that left the sidebar, and where their contents went. What was about one Bot is on that
 * Bot's page; what was the person's own is in Settings.
 *
 * 熊宝版：上游的 `/reachability`（@Waker）不搬走，仍是主导航里的跨员工总览；`/responsibilities` 只有带
 * `?agent=` 时才转到那位员工的长期职责分页（`legacyResponsibilitiesTarget`），不带时仍是全量页。其余是熊宝
 * 自己的旧地址，搬进上游的页面结构后（M5b）在这里统一维护。`/plans` 是服务端 `upgradeUrl` 的契约，所以只能
 * 重定向、不能删。
 */
export const LEGACY_PAGES = {
  "/approvals": "/settings/approvals",
  "/memory": "/capabilities/memory",
  // A group is started from the new-conversation screen by putting two or more Bots in To:.
  "/group/new": "/channel/new",
  // 团队 Bot：列表里「共享给你的」一节，加上每位员工的「共享」分页。
  "/team-bots": "/bots",
  "/knowledge": "/capabilities/knowledge",
  "/role-templates": "/capabilities/roles",
  "/plans": "/settings/plans",
  "/platform": "/admin/platform",
} as const;

/** `/wakers`（员工管理）的地址参数，和 `components/wakers/wakers-search.ts` 的 `WakersSearch` 同形。 */
type LegacyWakersSearch = {
  tab?: "groups";
  q?: string;
  status?: "working" | "resting" | "paused" | "unknown";
  role?: string;
  env?: "device" | "unbound";
  sort?: "name" | "recent" | "tasks";
  new?: true;
  agent?: string;
};

/**
 * `/wakers` → `/bots`。筛选、排序、群组页签和新建员工都照带；`?agent=<id>` 原来打开那位员工的编辑框，
 * 现在去那位员工自己的页面（同 `/agents?agent=`）。新建优先，和 `/agents` 一样。
 */
export function legacyWakersTarget(search: LegacyWakersSearch) {
  const { agent, ...wall } = search;
  if (agent && !wall.new) {
    return {
      to: "/bots/$agentId",
      params: { agentId: agent },
      replace: true,
    } as const;
  }
  return { to: "/bots", search: wall, replace: true } as const;
}

/** `/wakers/$agentId`（员工详情）→ `/bots/$agentId`。 */
export function legacyWakerTarget(agentId: string) {
  return {
    to: "/bots/$agentId",
    params: { agentId },
    replace: true,
  } as const;
}

/** `/assemble/$agentId`（装配）→ 那位员工的「设置」分页。 */
export function legacyAssembleTarget(agentId: string) {
  return {
    to: "/bots/$agentId/setup",
    params: { agentId },
    replace: true,
  } as const;
}

/** `/responsibilities?agent=X` → 那位员工的「长期职责」分页；不带 `agent` 时返回 null，页面照旧。 */
export function legacyResponsibilitiesTarget(search: { agent?: string }) {
  if (!search.agent) return null;
  return {
    to: "/bots/$agentId/responsibilities",
    params: { agentId: search.agent },
    replace: true,
  } as const;
}

/** `/resources?tab=` 的页签，和 `components/resources/resource-tabs.tsx` 的 `ResourceTab` 同名。 */
export type LegacyResourceTab =
  | "plugins"
  | "skills"
  | "connectors"
  | "knowledge"
  | "wakerflows"
  | "projects"
  | "models"
  | "components"
  | "sources";

/** 每个旧页签现在的地址。信息源与记忆（sources）进「记忆」；连接器进「连接」页。 */
export const LEGACY_RESOURCE_TABS = {
  plugins: "/capabilities/plugins",
  skills: "/capabilities/skills",
  connectors: "/connections",
  knowledge: "/capabilities/knowledge",
  wakerflows: "/capabilities/wakerflows",
  projects: "/capabilities/projects",
  models: "/capabilities/models",
  components: "/capabilities/components",
  sources: "/capabilities/memory",
} as const satisfies Record<LegacyResourceTab, string>;

type LegacyResourcesSearch = {
  tab?: LegacyResourceTab;
  view?: "market" | "mine";
  category?: string;
  page?: number;
  q?: string;
  new?: true;
  edit?: string;
};

/**
 * `/resources?tab=X` → 对应的能力页签（不带 `tab` 是插件，熊宝的默认页签）。每个页签自己的参数照带：
 * 插件的 `view,category,page,q`，技能的 `new,edit`，知识库、WakerFlow、组件的 `q`。
 */
export function legacyResourcesTarget(search: LegacyResourcesSearch) {
  const { tab = "plugins", view, category, page, q } = search;
  const query = q ? { q } : {};
  switch (tab) {
    case "plugins":
      return {
        to: LEGACY_RESOURCE_TABS.plugins,
        search: {
          ...(view ? { view } : {}),
          ...(category ? { category } : {}),
          ...(page ? { page } : {}),
          ...query,
        },
        replace: true,
      } as const;
    case "skills":
      return legacySkillsTarget(search);
    case "knowledge":
    case "wakerflows":
    case "components":
      return {
        to: LEGACY_RESOURCE_TABS[tab],
        search: query,
        replace: true,
      } as const;
    case "connectors":
    case "projects":
    case "models":
    case "sources":
      return { to: LEGACY_RESOURCE_TABS[tab], replace: true } as const;
  }
}

/** `/skills`（以及 `/resources?tab=skills`）→ 能力 › 技能，写技能的 `new` 和正在改的 `edit` 照带。 */
export function legacySkillsTarget(search: { new?: true; edit?: string }) {
  return {
    to: "/capabilities/skills",
    search: {
      ...(search.new ? { new: true } : {}),
      ...(search.edit ? { edit: search.edit } : {}),
    },
    replace: true,
  } as const;
}

/**
 * `/settings/connected-accounts` → `/connections`，回跳参数照带：迁移前发出去的授权，厂商记住的回跳地址
 * 还是旧的。
 */
export function legacyConnectedAccountsTarget(search: {
  connected?: string;
  authorized?: string;
  linked?: string;
}) {
  return { to: "/connections", search, replace: true } as const;
}

/** `/settings/connected-accounts/$key` → `/connections/$key`，`linked`、`action`、`connect` 照带。 */
export function legacyConnectedAccountTarget(
  key: string,
  search: { linked?: string; action?: string; connect?: true },
) {
  return {
    to: "/connections/$key",
    params: { key },
    search,
    replace: true,
  } as const;
}
