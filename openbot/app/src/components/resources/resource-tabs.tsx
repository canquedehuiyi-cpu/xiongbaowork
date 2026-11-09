import {
  type Icon,
  IconArrowRight,
  IconFolder,
  IconGitBranch,
  IconLink,
  IconNotebook,
  IconPuzzle,
  IconSparkles,
} from "@tabler/icons-react";
import { type KeyboardEvent, useRef } from "react";
import { cn } from "@/lib/utils";
import { CARD_FACE, ResourceSymbol, SectionHead } from "./resource-kit";

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
    icon: IconSparkles,
  },
  {
    value: "connectors",
    label: "连接器",
    description: "接入员工要用的外部系统",
    icon: IconLink,
  },
  {
    value: "knowledge",
    label: "知识库",
    description: "为员工准备可查阅的资料",
    icon: IconNotebook,
  },
  {
    value: "wakerflows",
    label: "WakerFlow",
    description: "把多步工作编排成流程",
    icon: IconGitBranch,
  },
  {
    value: "projects",
    label: "公开项目",
    description: "员工可在设备上共用的项目",
    icon: IconFolder,
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

const HEADING_ID = "resources-entry-heading";

/**
 * 「资源入口」 (docs/design/ios-studio, 05-能力与资源.png): the six entries as ONE continuous panel
 * split into six cells by hairlines — each a 33px icon plate top left, its name in 12px bold under
 * it, and an arrow bottom right. The selected cell is marked by a 2px red line along its bottom
 * edge, a red glyph and a slightly lighter ground; at 790px and under the panel folds to three
 * columns over two rows. This fork's own three entries are the small links on the right of the
 * section's title line (「模型库 · 组件 · 信息源与记忆」), the selected one underlined.
 *
 * Both are ONE tablist with `SegmentedTabs`' keyboard model — one stop in the tab order,
 * Left/Right/Home/End across all nine — drawn here rather than through it because a cell is not a
 * text tab and `components/layout` is shared by every page. The links sit in the tablist and are
 * placed on the title's line, so the heading stays outside it (a tablist owns tabs and nothing
 * else). The selected cell's line of description is its `aria-describedby` (read, not drawn), so a
 * tab's name stays the bare label; the arrows are decoration (`aria-hidden`).
 */
export function ResourceTabs({
  value,
  onValueChange,
}: {
  value: ResourceTab;
  /** `keyboard` is true for arrow/Home/End moves, which should replace history rather than push. */
  onValueChange: (value: ResourceTab, change: { keyboard: boolean }) => void;
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
    onValueChange(tab.value, { keyboard: true });
    refs.current.get(tab.value)?.focus();
  };

  const tabProps = (tab: ResourceTab, index: number) => {
    const selected = tab === value;
    return {
      "aria-controls": resourcePanelId(tab),
      "aria-selected": selected,
      id: resourceTabId(tab),
      onClick: () => onValueChange(tab, { keyboard: false }),
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
    <section aria-labelledby={HEADING_ID} className="relative mt-[5px]">
      <SectionHead id={HEADING_ID} title="资源入口" />
      <div aria-label="能力与资源" role="tablist">
        <div
          className={cn(
            CARD_FACE,
            "grid grid-cols-3 overflow-hidden rounded-[14px] min-[791px]:grid-cols-6",
          )}
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
                aria-describedby={
                  selected ? descriptionId(tab.value) : undefined
                }
                aria-labelledby={labelId}
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
              >
                <ResourceSymbol active={selected}>
                  <Glyph stroke={1.6} />
                </ResourceSymbol>
                <span
                  className="mt-[6px] max-w-full truncate pr-[14px] font-bold text-[13px] text-foreground leading-[18px]"
                  data-slot="entry-label"
                  id={labelId}
                >
                  {tab.label}
                </span>
                {selected ? (
                  <span
                    className="sr-only"
                    data-slot="entry-description"
                    id={descriptionId(tab.value)}
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
              </button>
            );
          })}
        </div>
        <div
          // On the title's line, right-aligned: the section's own secondary entries.
          className="absolute top-0 right-0 flex h-[26px] max-w-[calc(100%-90px)] items-center justify-end gap-x-[2px] overflow-hidden text-[12px]"
          data-slot="resource-more-tabs"
        >
          {OWN_RESOURCE_TABS.map((tab, index) => {
            const selected = tab.value === value;
            return (
              <span
                className="flex min-w-0 items-center gap-x-[2px]"
                key={tab.value}
              >
                {index > 0 ? (
                  <span aria-hidden="true" className="text-faint">
                    ·
                  </span>
                ) : null}
                <button
                  {...tabProps(tab.value, RESOURCE_TABS.length + index)}
                  className={cn(
                    "inline-flex h-[24px] items-center whitespace-nowrap rounded-[7px] px-[4px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none",
                    selected
                      ? "font-semibold text-foreground underline decoration-2 decoration-signal underline-offset-[6px]"
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
    </section>
  );
}
