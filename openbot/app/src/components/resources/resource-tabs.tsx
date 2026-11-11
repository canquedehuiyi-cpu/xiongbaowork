import {
  type Icon,
  IconArrowRight,
  IconCpu,
  IconFolder,
  IconGitBranch,
  IconNotebook,
  IconPuzzle,
  IconSparkles,
} from "@tabler/icons-react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { CARD_FACE, ResourceSymbol, SectionHead } from "./resource-kit";

/**
 * 能力的页签（M5b：上游的 `/capabilities/*` 结构，熊宝的「资源入口」画法）。
 *
 * 每个页签是自己的地址（`capabilities.<tab>.tsx`），所以页签是链接，不是 `role="tab"`：刷新、后退、
 * 新标签页打开、分享链接都落在同一页签上。前六个画成「资源入口」的六格面板，各带一句它是做什么的；后三个是
 * 标题行右侧的小链接。连接器搬去了「连接」页（`/connections`），不在这里。
 */
export const CAPABILITY_TABS = [
  {
    to: "/capabilities/plugins",
    label: "插件",
    description: "探索与扩展员工能力",
    icon: IconPuzzle,
  },
  {
    to: "/capabilities/skills",
    label: "技能",
    description: "沉淀可复用的做事方法",
    icon: IconSparkles,
  },
  {
    to: "/capabilities/knowledge",
    label: "知识库",
    description: "为员工准备可查阅的资料",
    icon: IconNotebook,
  },
  {
    to: "/capabilities/wakerflows",
    label: "WakerFlow",
    description: "把多步工作编排成流程",
    icon: IconGitBranch,
  },
  {
    to: "/capabilities/projects",
    label: "公开项目",
    description: "员工可在设备上共用的项目",
    icon: IconFolder,
  },
  {
    to: "/capabilities/models",
    label: "模型库",
    description: "员工用的模型与平台体验模型",
    icon: IconCpu,
  },
] as const satisfies readonly {
  to: string;
  label: string;
  description: string;
  icon: Icon;
}[];

export const MORE_CAPABILITY_TABS = [
  { to: "/capabilities/components", label: "组件" },
  { to: "/capabilities/memory", label: "记忆与信息源" },
  { to: "/capabilities/roles", label: "角色模板" },
] as const satisfies readonly { to: string; label: string }[];

export type CapabilityTab =
  | (typeof CAPABILITY_TABS)[number]
  | (typeof MORE_CAPABILITY_TABS)[number];

export const ALL_CAPABILITY_TABS: readonly CapabilityTab[] = [
  ...CAPABILITY_TABS,
  ...MORE_CAPABILITY_TABS,
];

/**
 * 当前地址落在哪个页签上。模糊匹配，所以 `/capabilities/skills?edit=x` 这类页签下面的状态仍点亮它；
 * 不在任何页签上时是 undefined。
 */
export function useCurrentCapabilityTab(): CapabilityTab | undefined {
  const matchRoute = useMatchRoute();
  return ALL_CAPABILITY_TABS.find((tab) =>
    matchRoute({ to: tab.to, fuzzy: true }),
  );
}

const HEADING_ID = "capabilities-entry-heading";
const tabSlug = (to: string) => to.split("/").pop();
const labelId = (to: string) => `capabilities-tab-${tabSlug(to)}-label`;
const descriptionId = (to: string) => `capabilities-tab-${tabSlug(to)}-desc`;

/**
 * 「资源入口」(docs/design/ios-studio, 05-能力与资源.png)：六个入口是一整块面板，用细线分成六格——左上 33px
 * 图标底板，下面 13px 粗体名字，右下一个箭头。当前格底边一道 2px 红线、红色图标、底色略亮；790px 及以下折成
 * 三列两行。熊宝自己的三个入口是分区标题行右侧的小链接（「组件 · 记忆与信息源 · 角色模板」），当前那个加下划线。
 *
 * 全部是导航链接（`<nav>`），当前页签带 `aria-current="page"`；格子的名字由它的名字那一行给
 * （`aria-labelledby`），当前格的那句说明是它的 `aria-describedby`（读出来，不画出来），所以链接的名字就是
 * 页签名本身；箭头是装饰（`aria-hidden`）。
 */
export function CapabilityTabs() {
  const current = useCurrentCapabilityTab();

  return (
    <section aria-labelledby={HEADING_ID} className="relative mt-[5px]">
      <SectionHead id={HEADING_ID} title="资源入口" />
      <nav aria-label="能力">
        <div
          className={cn(
            CARD_FACE,
            "grid grid-cols-3 overflow-hidden rounded-[14px] min-[791px]:grid-cols-6",
          )}
          data-slot="resource-entry-cards"
        >
          {CAPABILITY_TABS.map((tab, index) => {
            const selected = tab === current;
            const Glyph = tab.icon;
            return (
              <Link
                aria-current={selected ? "page" : undefined}
                aria-describedby={selected ? descriptionId(tab.to) : undefined}
                aria-labelledby={labelId(tab.to)}
                className={cn(
                  "relative flex min-h-[86px] min-w-0 flex-col items-start px-[11px] pt-[9px] pb-[11px] text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset motion-reduce:transition-none",
                  // Hairlines between cells: one row of six, or three over three at 790px and under.
                  index > 0 ? "border-border border-l" : null,
                  index === 3 ? "max-[790px]:border-l-0" : null,
                  index >= 3
                    ? "max-[790px]:border-border max-[790px]:border-t"
                    : null,
                  selected
                    ? "bg-foreground/[0.03] shadow-[inset_0_-2px_0_var(--signal)]"
                    : "hover:bg-foreground/[0.02]",
                )}
                data-state={selected ? "active" : "idle"}
                key={tab.to}
                to={tab.to}
              >
                <ResourceSymbol active={selected}>
                  <Glyph stroke={1.6} />
                </ResourceSymbol>
                <span
                  className="mt-[6px] max-w-full truncate pr-[14px] font-bold text-[13px] text-foreground leading-[18px]"
                  data-slot="entry-label"
                  id={labelId(tab.to)}
                >
                  {tab.label}
                </span>
                {selected ? (
                  <span
                    className="sr-only"
                    data-slot="entry-description"
                    id={descriptionId(tab.to)}
                  >
                    {tab.description}
                  </span>
                ) : null}
                <IconArrowRight
                  aria-hidden="true"
                  className={cn(
                    "absolute right-[9px] bottom-[11px] size-[13px]",
                    selected ? "text-foreground/80" : "text-faint",
                  )}
                  data-slot="entry-arrow"
                  data-state={selected ? "active" : "idle"}
                  stroke={1.8}
                />
              </Link>
            );
          })}
        </div>
        <div
          // On the title's line, right-aligned: the section's own secondary entries.
          className="absolute top-0 right-0 flex h-[26px] max-w-[calc(100%-90px)] items-center justify-end gap-x-[2px] overflow-hidden text-[12px]"
          data-slot="resource-more-tabs"
        >
          {MORE_CAPABILITY_TABS.map((tab, index) => {
            const selected = tab === current;
            return (
              <span
                className="flex min-w-0 items-center gap-x-[2px]"
                key={tab.to}
              >
                {index > 0 ? (
                  <span aria-hidden="true" className="text-faint">
                    ·
                  </span>
                ) : null}
                <Link
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "inline-flex h-[24px] items-center whitespace-nowrap rounded-[7px] px-[4px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none",
                    selected
                      ? "font-semibold text-foreground underline decoration-2 decoration-signal underline-offset-[6px]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  to={tab.to}
                >
                  {tab.label}
                </Link>
              </span>
            );
          })}
        </div>
      </nav>
    </section>
  );
}

/*
 * ── 旧地址 `/resources?tab=` ──────────────────────────────────────────────────────────────────
 *
 * 能力与资源原来是一页九个页签，选中的是 `?tab=`。地址保留成重定向（`routes/_authed/_app/resources.tsx`，
 * 去向见 `lib/agents/legacy-routes.ts` 的 `legacyResourcesTarget`），这里只留它的地址参数校验：旧链接、
 * 书签和对话历史里的 `/resources?tab=…` 照样能解析，每个页签自己的参数照带。
 */
const LEGACY_RESOURCE_TABS = [
  "plugins",
  "skills",
  "connectors",
  "knowledge",
  "wakerflows",
  "projects",
  "models",
  "components",
  "sources",
] as const;

export type ResourceTab = (typeof LEGACY_RESOURCE_TABS)[number];

export function isResourceTab(value: unknown): value is ResourceTab {
  return LEGACY_RESOURCE_TABS.some((tab) => tab === value);
}

export type ResourcesSearch = {
  tab?: ResourceTab;
  view?: "market" | "mine";
  category?: string;
  page?: number;
  q?: string;
  /** 技能: the authoring panel is open. */
  new?: true;
  /** 技能: the slug being edited. */
  edit?: string;
};

export function resourcesSearch(
  search: Record<string, unknown>,
): ResourcesSearch {
  const page = Number(search.page);
  // A numeric slug arrives as a number: the default search parser reads `?edit=42` as JSON.
  const edit =
    typeof search.edit === "number" ? String(search.edit) : search.edit;
  const q = typeof search.q === "number" ? String(search.q) : search.q;
  return {
    ...(isResourceTab(search.tab) ? { tab: search.tab } : {}),
    ...(search.view === "market" || search.view === "mine"
      ? { view: search.view }
      : {}),
    ...(typeof search.category === "string" && search.category
      ? { category: search.category }
      : {}),
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    ...(typeof q === "string" && q ? { q } : {}),
    ...(search.new === true || search.new === "true"
      ? { new: true as const }
      : {}),
    ...(typeof edit === "string" && edit ? { edit } : {}),
  };
}
