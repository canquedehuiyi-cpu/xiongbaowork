import {
  type Icon,
  IconArrowRight,
  IconBook2,
  IconBulb,
  IconFolders,
  IconPlugConnected,
  IconPuzzle,
  IconRoute,
} from "@tabler/icons-react";
import { type KeyboardEvent, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * The entries of 能力与资源, in the reference product's order, then this fork's own entries.
 *
 * The first six are QoderWake's (插件 · 技能 · 连接器 · 知识库 · WakerFlow · 公开项目), each drawn as
 * an entry card with a line saying what it is for; the three after them are what this deployment has
 * and the reference does not: the model library, the components employees answer with, and the
 * synced sources and memory.
 */
export const RESOURCE_TABS = [
  {
    value: "plugins",
    label: "插件",
    description: "探索与扩展员工能力",
    icon: IconPuzzle,
  },
  {
    value: "skills",
    label: "技能",
    description: "沉淀可复用的做事方法",
    icon: IconBulb,
  },
  {
    value: "connectors",
    label: "连接器",
    description: "接入员工要用的外部系统",
    icon: IconPlugConnected,
  },
  {
    value: "knowledge",
    label: "知识库",
    description: "为员工准备可查阅的资料",
    icon: IconBook2,
  },
  {
    value: "wakerflows",
    label: "WakerFlow",
    description: "把多步工作编排成流程",
    icon: IconRoute,
  },
  {
    value: "projects",
    label: "公开项目",
    description: "员工可在设备上共用的项目",
    icon: IconFolders,
  },
] as const satisfies readonly {
  value: string;
  label: string;
  description: string;
  icon: Icon;
}[];

export const OWN_RESOURCE_TABS = [
  { value: "models", label: "模型库" },
  { value: "components", label: "组件" },
  { value: "sources", label: "信息源与记忆" },
] as const;

export type ResourceTab =
  | (typeof RESOURCE_TABS)[number]["value"]
  | (typeof OWN_RESOURCE_TABS)[number]["value"];

const ALL: readonly { value: ResourceTab; label: string }[] = [
  ...RESOURCE_TABS,
  ...OWN_RESOURCE_TABS,
];

export function isResourceTab(value: unknown): value is ResourceTab {
  return ALL.some((tab) => tab.value === value);
}

export const resourceTabId = (value: ResourceTab) => `resources-tab-${value}`;
export const resourcePanelId = (value: ResourceTab) =>
  `resources-panel-${value}`;
const descriptionId = (value: ResourceTab) => `resources-tab-${value}-desc`;

/**
 * The entry row: six equal cards (the reference's 86px entries on the sidebar's grey), then this
 * fork's own three as a compact line of text tabs under them. The six share one row from a 1200px
 * window up; below that a card is too narrow for 「WakerFlow」 beside its icon, so they wrap 3 × 2.
 *
 * Both rows are ONE tablist with `SegmentedTabs`' keyboard model — one stop in the tab order,
 * Left/Right/Home/End across all nine — drawn here rather than through it because a card is not a
 * text tab and `components/layout` is shared by every page. The selected card's description is its
 * `aria-describedby`, so a tab's name stays the bare label; the round arrow and the 「更多资源：」
 * caption are decoration (`aria-hidden`), since a tablist owns tabs and nothing else.
 */
export function ResourceTabs({
  value,
  onValueChange,
}: {
  value: ResourceTab;
  onValueChange: (value: ResourceTab) => void;
}) {
  const refs = useRef(new Map<ResourceTab, HTMLButtonElement>());

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = ALL.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const tab = ALL[next];
    if (!tab) return;
    onValueChange(tab.value);
    refs.current.get(tab.value)?.focus();
  };

  const tabProps = (tab: ResourceTab, index: number) => {
    const selected = tab === value;
    return {
      "aria-controls": resourcePanelId(tab),
      "aria-selected": selected,
      id: resourceTabId(tab),
      onClick: () => onValueChange(tab),
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
        move(event, index),
      ref: (node: HTMLButtonElement | null) => {
        if (node) refs.current.set(tab, node);
        else refs.current.delete(tab);
      },
      role: "tab",
      tabIndex: selected ? 0 : -1,
      type: "button",
    } as const;
  };

  return (
    <div aria-label="能力与资源" className="mt-[24px]" role="tablist">
      <div
        className="grid grid-cols-3 gap-[12px] xl:grid-cols-6"
        data-slot="resource-entry-cards"
      >
        {RESOURCE_TABS.map((tab, index) => {
          const selected = tab.value === value;
          const Glyph = tab.icon;
          const labelId = `${resourceTabId(tab.value)}-label`;
          return (
            <button
              key={tab.value}
              {...tabProps(tab.value, index)}
              aria-describedby={selected ? descriptionId(tab.value) : undefined}
              aria-labelledby={labelId}
              className={cn(
                "relative flex h-[86px] min-w-0 flex-col items-start gap-[6px] rounded-lg bg-sidebar px-[16px] pt-[16px] text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
                selected ? "" : "hover:bg-sidebar-accent/60",
              )}
            >
              <span className="flex min-w-0 max-w-full items-center gap-[8px]">
                <Glyph
                  aria-hidden="true"
                  className={cn(
                    "size-[18px] shrink-0",
                    selected ? "text-foreground" : "text-muted-foreground",
                  )}
                />
                <span
                  className="truncate font-semibold text-[14px] text-foreground leading-[20px]"
                  data-slot="entry-label"
                  id={labelId}
                >
                  {tab.label}
                </span>
              </span>
              {selected ? (
                <span
                  className="max-w-full truncate pr-[32px] text-[12px] text-muted-foreground leading-[18px]"
                  data-slot="entry-description"
                  id={descriptionId(tab.value)}
                >
                  {tab.description}
                </span>
              ) : null}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute right-[12px] bottom-[12px] flex size-[24px] items-center justify-center rounded-full",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "border border-foreground/15 text-muted-foreground/60",
                )}
                data-slot="entry-arrow"
                data-state={selected ? "active" : "idle"}
              >
                <IconArrowRight className="size-[14px]" stroke={2} />
              </span>
            </button>
          );
        })}
      </div>
      <div
        className="mt-[10px] flex flex-wrap items-center gap-x-[4px] gap-y-1 text-[12px]"
        data-slot="resource-more-tabs"
      >
        <span aria-hidden="true" className="text-muted-foreground">
          更多资源：
        </span>
        {OWN_RESOURCE_TABS.map((tab, index) => {
          const selected = tab.value === value;
          return (
            <span className="flex items-center gap-x-[4px]" key={tab.value}>
              {index > 0 ? (
                <span aria-hidden="true" className="text-muted-foreground/60">
                  ·
                </span>
              ) : null}
              <button
                {...tabProps(tab.value, RESOURCE_TABS.length + index)}
                className={cn(
                  "inline-flex h-[24px] items-center rounded-md px-[6px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
                  selected
                    ? "bg-sidebar-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
