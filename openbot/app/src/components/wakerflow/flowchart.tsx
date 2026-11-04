import { type ReactNode, useId } from "react";
import { STEP_KIND_LABEL, stepKind, WAKERFLOW_END } from "@/lib/wakerflows";

/**
 * The WakerFlow flowchart (WF7, spec §3.6): the plan's steps top to bottom, drawn with CSS grid and
 * inline SVG, no graph library.
 *
 * Coworker steps, actions and nested Flows are rectangles, a decision is a diamond whose branches are
 * listed beside it. A step that goes on to the next one in order is joined to it by a short arrow; a
 * jump (a branch, a `next`, the end) is drawn in the lanes on the left, from the step's left edge
 * down to its target's. Every jump points forward (P-A), so a lane line only ever runs downwards.
 *
 * The same component shows a run: each node is then coloured by its step's state, and a step no taken
 * branch reached is drawn differently from one a person skipped, with the words for each.
 *
 * Read-only by itself. The editor passes `onSelect` and the selected id: a node is then a button,
 * and choosing one opens that step's form beside the chart (D8: no drag-to-connect).
 */

/** What the chart reads of a step: the plan's own step and a run's step both fit. */
export type FlowchartStep = {
  id: string;
  kind?: string;
  next?: string;
  branches?: { label: string; next: string }[];
  otherwise?: string;
};

export type FlowchartState = {
  state: string;
  skipReason?: "branch" | "person";
};

const ROW = 84;
const NODE = 56;
const LANE = 16;

type Edge = { from: number; to: number; label?: string };

/** Every route out of each step, resolved to positions; `count` is the end. */
function edgesOf(steps: FlowchartStep[]): Edge[] {
  const count = steps.length;
  const position = new Map(steps.map((step, index) => [step.id, index]));
  const resolve = (index: number, target: string | undefined) => {
    if (target === undefined) return index + 1;
    if (target === WAKERFLOW_END) return count;
    const to = position.get(target);
    // A target that is missing or behind (which Save refuses) is drawn to the end, never upwards.
    return to !== undefined && to > index ? to : count;
  };
  return steps.flatMap((step, index): Edge[] =>
    step.kind === "decision"
      ? [
          ...(step.branches ?? []).map((branch) => ({
            from: index,
            to: resolve(index, branch.next),
            label: branch.label,
          })),
          {
            from: index,
            to: resolve(index, step.otherwise ?? WAKERFLOW_END),
            label: "否则",
          },
        ]
      : [{ from: index, to: resolve(index, step.next) }],
  );
}

/** Lanes for the jumps, shortest first, so nested jumps sit inside the longer ones. */
function lanesOf(jumps: Edge[]): Map<Edge, number> {
  const lanes = new Map<Edge, number>();
  const taken: Edge[][] = [];
  for (const edge of [...jumps].sort(
    (a, b) => a.to - a.from - (b.to - b.from),
  )) {
    let lane = 0;
    while (
      (taken[lane] ?? []).some(
        (other) => edge.from < other.to && other.from < edge.to,
      )
    )
      lane += 1;
    const row = taken[lane] ?? [];
    row.push(edge);
    taken[lane] = row;
    lanes.set(edge, lane);
  }
  return lanes;
}

/** How a step's state is drawn: its look and the words beside it. */
function stateLook(entry: FlowchartState | undefined): {
  key: string;
  className: string;
  text?: string;
} {
  if (!entry) return { key: "plan", className: "border-border" };
  switch (entry.state) {
    case "done":
      return {
        key: "done",
        className: "border-emerald-600 dark:border-emerald-400",
        text: "已完成",
      };
    case "running":
      return {
        key: "running",
        className: "border-sky-600 dark:border-sky-400",
        text: "进行中",
      };
    case "awaiting_action":
      return {
        key: "awaiting_action",
        className: "border-amber-600 dark:border-amber-400",
        text: "等待处理",
      };
    case "failed":
      return {
        key: "failed",
        className: "border-destructive text-destructive",
        text: "失败",
      };
    case "skipped":
      return entry.skipReason === "branch"
        ? {
            key: "skipped-branch",
            className: "border-dashed border-border opacity-60",
            text: "分支未选中",
          }
        : {
            key: "skipped-person",
            className: "border-border bg-muted line-through",
            text: "已跳过",
          };
    case "aborted":
      return {
        key: "aborted",
        className: "border-border opacity-60",
        text: "已中止",
      };
    default:
      return {
        key: entry.state,
        className: "border-border",
        text: entry.state === "pending" ? "未开始" : entry.state,
      };
  }
}

export function Flowchart(props: {
  steps: FlowchartStep[];
  /** What a node says: its title. */
  title: (step: FlowchartStep, index: number) => string;
  /** A second, quieter line (who does it, what it reads). */
  detail?: (step: FlowchartStep, index: number) => string | undefined;
  /** Something a node carries below its text, such as the nested Flow's link. */
  extra?: (step: FlowchartStep, index: number) => ReactNode;
  /** A run's step states, by step id. */
  states?: Record<string, FlowchartState>;
  selectedId?: string;
  onSelect?: (id: string) => void;
  label?: string;
}) {
  const { steps } = props;
  const marker = `flowchart-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const edges = edgesOf(steps);
  const jumps = edges.filter((edge) => edge.to !== edge.from + 1);
  const lanes = lanesOf(jumps);
  const laneCount = Math.max(0, ...[...lanes.values()].map((lane) => lane + 1));
  const width = laneCount * LANE + 8;
  const height = (steps.length + 1) * ROW;
  const centre = (index: number) => index * ROW + NODE / 2;
  const position = (to: number) =>
    to >= steps.length ? "结束" : `第 ${to + 1} 步`;

  return (
    <figure
      aria-label={props.label ?? "流程图"}
      className="relative"
      style={{ paddingLeft: width }}
    >
      <svg
        aria-hidden="true"
        className="absolute top-0 left-0 text-muted-foreground"
        height={height}
        width={width}
      >
        <defs>
          <marker
            id={marker}
            markerHeight="6"
            markerWidth="6"
            orient="auto"
            refX="5"
            refY="3"
          >
            <path d="M0,0 L6,3 L0,6 z" fill="currentColor" />
          </marker>
        </defs>
        {jumps.map((edge) => {
          const lane = lanes.get(edge) ?? 0;
          const x = width - 8 - lane * LANE - LANE / 2;
          return (
            <path
              d={`M ${width} ${centre(edge.from)} H ${x} V ${centre(edge.to)} H ${width - 1}`}
              data-edge={`${edge.from}->${edge.to}`}
              data-label={edge.label ?? ""}
              fill="none"
              key={`${edge.from}-${edge.to}-${edge.label ?? ""}`}
              markerEnd={`url(#${marker})`}
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <title>
                {edge.label
                  ? `${edge.label} → ${position(edge.to)}`
                  : `→ ${position(edge.to)}`}
              </title>
            </path>
          );
        })}
      </svg>
      <ol className="flex flex-col">
        {steps.map((step, index) => {
          const kind = stepKind(step);
          const look = stateLook(props.states?.[step.id]);
          const selected = props.selectedId === step.id;
          const onward = edges.filter(
            (edge) => edge.from === index && edge.to === index + 1,
          );
          const routes = edges.filter((edge) => edge.from === index);
          const body = (
            <>
              <span className="block truncate font-medium">
                第 {index + 1} 步 · <span>{props.title(step, index)}</span>
              </span>
              <span className="block truncate text-muted-foreground text-xs">
                {STEP_KIND_LABEL[kind]}
                {props.detail?.(step, index)
                  ? ` · ${props.detail(step, index)}`
                  : ""}
                {look.text ? ` · ${look.text}` : ""}
              </span>
            </>
          );
          const nodeClass = `relative flex h-full min-w-0 flex-1 flex-col justify-center rounded-md border px-3 text-left text-sm ${look.className} ${
            selected ? "ring-2 ring-ring" : ""
          }`;
          const node =
            kind === "decision" ? (
              <div
                className={`relative flex h-full min-w-0 flex-1 flex-col justify-center px-8 text-center text-sm ${look.className.replace(/border-\S+/g, "")} ${
                  selected ? "rounded-md ring-2 ring-ring" : ""
                }`}
                data-shape="diamond"
              >
                <svg
                  aria-hidden="true"
                  className="absolute inset-0 h-full w-full text-border"
                  preserveAspectRatio="none"
                  viewBox="0 0 100 100"
                >
                  <polygon
                    className={
                      look.key === "failed"
                        ? "text-destructive"
                        : look.key === "done"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : undefined
                    }
                    fill="var(--background)"
                    points="50,1 99,50 50,99 1,50"
                    stroke="currentColor"
                    strokeDasharray={
                      look.key === "skipped-branch" ? "4 3" : undefined
                    }
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                <span className="relative">{body}</span>
              </div>
            ) : (
              <div className={nodeClass} data-shape="box">
                {body}
              </div>
            );
          return (
            <li
              className="flex flex-col"
              data-kind={kind}
              data-state={look.key}
              data-step={step.id}
              key={step.id}
              style={{ height: ROW }}
            >
              <div className="flex flex-row gap-2" style={{ height: NODE }}>
                {props.onSelect ? (
                  <button
                    aria-label={`第 ${index + 1} 步：${props.title(step, index)}`}
                    aria-pressed={selected}
                    className="flex min-w-0 flex-1 flex-row"
                    onClick={() => props.onSelect?.(step.id)}
                    type="button"
                  >
                    {node}
                  </button>
                ) : (
                  node
                )}
                {kind === "decision" ? (
                  <ul
                    aria-label={`第 ${index + 1} 步的分支`}
                    className="flex w-2/5 min-w-0 flex-col justify-center overflow-y-auto text-xs"
                  >
                    {routes.map((edge) => (
                      <li className="truncate" key={`${edge.label}-${edge.to}`}>
                        {edge.label} → {position(edge.to)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div
                className="flex flex-row items-center gap-2 pl-6 text-muted-foreground text-xs"
                style={{ height: ROW - NODE }}
              >
                {onward.length > 0 ? (
                  <svg aria-hidden="true" height={ROW - NODE} width="12">
                    <path
                      d={`M 6 2 V ${ROW - NODE - 2}`}
                      markerEnd={`url(#${marker})`}
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                  </svg>
                ) : null}
                {props.extra?.(step, index)}
              </div>
            </li>
          );
        })}
        <li
          className="flex items-center"
          data-step={WAKERFLOW_END}
          style={{ height: NODE }}
        >
          <span className="rounded-full border border-border px-4 py-1 text-muted-foreground text-xs">
            结束
          </span>
        </li>
      </ol>
    </figure>
  );
}
