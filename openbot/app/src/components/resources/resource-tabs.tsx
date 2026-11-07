import { type KeyboardEvent, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * The tabs of 能力与资源, in the reference product's order, then this fork's own entries.
 *
 * The first six are QoderWake's (插件 · 技能 · 连接器 · 知识库 · WakerFlow · 公开项目); the three
 * after the divider are what this deployment has and the reference does not: the model library, the
 * components employees answer with, and the synced sources and memory.
 */
export const RESOURCE_TABS = [
  { value: "plugins", label: "插件" },
  { value: "skills", label: "技能" },
  { value: "connectors", label: "连接器" },
  { value: "knowledge", label: "知识库" },
  { value: "wakerflows", label: "WakerFlow" },
  { value: "projects", label: "公开项目" },
] as const;

export const OWN_RESOURCE_TABS = [
  { value: "models", label: "模型库" },
  { value: "components", label: "组件" },
  { value: "sources", label: "信息源与记忆" },
] as const;

export type ResourceTab =
  | (typeof RESOURCE_TABS)[number]["value"]
  | (typeof OWN_RESOURCE_TABS)[number]["value"];

const ALL = [...RESOURCE_TABS, ...OWN_RESOURCE_TABS];

export function isResourceTab(value: unknown): value is ResourceTab {
  return ALL.some((tab) => tab.value === value);
}

export const resourceTabId = (value: ResourceTab) => `resources-tab-${value}`;
export const resourcePanelId = (value: ResourceTab) =>
  `resources-panel-${value}`;

/**
 * The tab row.
 *
 * `SegmentedTabs`' look and keyboard model (one stop in the tab order, Left/Right/Home/End across
 * every tab), drawn here rather than through it only because it has no place for the divider
 * between the reference's six and this fork's three — and `components/layout` is shared by every
 * page, so a divider is not added there for one screen. The divider is decoration (`aria-hidden`):
 * a tablist owns tabs and nothing else.
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

  const button = (tab: (typeof ALL)[number], index: number) => {
    const selected = tab.value === value;
    return (
      <button
        aria-controls={resourcePanelId(tab.value)}
        aria-selected={selected}
        className={cn(
          "inline-flex h-[28px] items-center justify-center whitespace-nowrap rounded-md px-3 font-medium text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
          selected
            ? "bg-background text-foreground shadow-xs dark:bg-foreground/10"
            : "text-muted-foreground hover:text-foreground",
        )}
        id={resourceTabId(tab.value)}
        key={tab.value}
        onClick={() => onValueChange(tab.value)}
        onKeyDown={(event) => move(event, index)}
        ref={(node) => {
          if (node) refs.current.set(tab.value, node);
          else refs.current.delete(tab.value);
        }}
        role="tab"
        tabIndex={selected ? 0 : -1}
        type="button"
      >
        {tab.label}
      </button>
    );
  };

  return (
    <div className="mt-[20px] max-w-full overflow-x-auto">
      <div
        aria-label="能力与资源"
        className="inline-flex items-center gap-0.5 rounded-lg bg-foreground/[0.04] p-0.5"
        role="tablist"
      >
        {RESOURCE_TABS.map((tab, index) => button(tab, index))}
        <span
          aria-hidden
          className="mx-1.5 h-[16px] w-px shrink-0 bg-border"
          data-slot="tab-divider"
        />
        {OWN_RESOURCE_TABS.map((tab, index) =>
          button(tab, RESOURCE_TABS.length + index),
        )}
      </div>
    </div>
  );
}
