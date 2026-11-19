import {
  IconInfoCircle,
  IconLayoutGrid,
  IconLink,
  IconList,
  IconPlus,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LabeledSelect } from "@/components/layout/labeled-select";
import { SearchBox } from "@/components/layout/search-box";
import { SegmentedTabs } from "@/components/layout/segmented-tabs";
import { WorkbenchEmpty } from "@/components/layout/workbench-empty";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSearchDraft } from "@/lib/use-search-draft";
import { cn } from "@/lib/utils";
import {
  type ChatRow,
  type ChatStatus,
  type ChatType,
  DELIVERY_STATE_LABELS,
  type ReachabilitySearch,
  STATUS_LABELS,
  TYPE_LABELS,
} from "./chats";

/*
 * docs/design/ios-studio: white is the working state, red only what needs attention. The label beside
 * the dot always says which, so the colour is never the only signal.
 */
const STATUS_TONE: Record<ChatStatus, string> = {
  connected: "bg-foreground",
  failed: "bg-signal",
  optedOut: "bg-faint",
};

function StatusBadge({ row }: { row: ChatRow }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", STATUS_TONE[row.status])}
      />
      <span
        className={cn(
          row.status === "failed" && "text-signal-ink",
          row.status === "optedOut" && "text-muted-foreground",
        )}
      >
        {STATUS_LABELS[row.status]}
      </span>
    </span>
  );
}

function lastDelivery(row: ChatRow): string {
  if (!row.last) return "暂无";
  const state = DELIVERY_STATE_LABELS[row.last.state] ?? row.last.state;
  return `${state} · ${new Date(row.last.createdAt).toLocaleString()}`;
}

function ChatTypeCell({ row }: { row: ChatRow }) {
  return (
    <div className="grid">
      <span>{TYPE_LABELS[row.type]}</span>
      {row.detail && (
        <span className="text-[12px] text-muted-foreground">
          {row.detail}
          {row.status === "optedOut" && "（已回复 STOP；发送 START 可恢复）"}
        </span>
      )}
    </div>
  );
}

export type ChatActions = {
  onRemove: (row: ChatRow) => void;
  removing: boolean;
};

function RowActions({ row, actions }: { row: ChatRow; actions: ChatActions }) {
  return (
    <div className="flex flex-nowrap gap-1.5">
      {row.channelId && (
        <Link
          className={buttonVariants({ size: "xs", variant: "ghost" })}
          params={{ channelId: row.channelId }}
          to="/channel/$channelId"
        >
          打开对话
        </Link>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={actions.removing}
        onClick={() => actions.onRemove(row)}
      >
        {row.kind === "device" ? "移除设备" : "断开连接"}
      </Button>
    </div>
  );
}

/**
 * The table's columns, as docs/design/ios-studio/02-Waker.png heads them (theme.css `.table-head`:
 * 1.4fr 1fr 1fr 1fr .85fr .85fr, the actions last). The design has no selection column — this page
 * has no bulk action to select rows for — and no 启用 column: a connection has no pause switch, and
 * a disconnected chat is no longer listed, so every row would have read 已启用.
 */
const COLUMNS: { label: string; width?: string; info?: string }[] = [
  { label: "聊天", width: "19%" },
  { label: "IM 连接", width: "15%" },
  { label: "执行目标", width: "14%" },
  { label: "工作目录", width: "11%" },
  {
    label: "模型",
    width: "13%",
    info: "员工在这段聊天里回复时使用的模型，与员工自己的设置一致。",
  },
  { label: "聊天状态", width: "11%" },
  // Takes what is left: both row actions, at xs, on one line.
  { label: "操作" },
];

const cellClass = "px-[15px] align-middle";

/** theme.css `.chat-table.glass`: the graphite panel the table and its empty states sit in. */
const PANEL =
  "overflow-hidden rounded-[14px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]";

function ChatTable({
  rows,
  actions,
  body,
}: {
  rows: ChatRow[];
  actions: ChatActions;
  /** Drawn across every column in place of rows: loading, empty, or nothing matching. */
  body?: ReactNode;
}) {
  return (
    <div className={PANEL}>
      <div className="overflow-x-auto">
        <table
          aria-label="已接入聊天"
          className="w-full min-w-[880px] table-fixed text-[13px]"
        >
          <colgroup>
            {COLUMNS.map((column) => (
              <col
                key={column.label}
                style={column.width ? { width: column.width } : undefined}
              />
            ))}
          </colgroup>
          <thead className="text-left text-[11px] text-muted-foreground">
            <tr className="h-[38px] border-border border-b">
              {COLUMNS.map((column) => (
                <th className={cn(cellClass, "font-medium")} key={column.label}>
                  <span className="inline-flex items-center gap-1">
                    {column.label}
                    {column.info && (
                      <span className="inline-flex" title={column.info}>
                        <IconInfoCircle
                          aria-hidden
                          className="size-[12px] text-faint"
                        />
                      </span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body ? (
              <tr>
                <td className="p-0" colSpan={COLUMNS.length}>
                  {body}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  className="h-[52px] border-border border-t first:border-t-0 hover:bg-foreground/[0.025]"
                  key={row.id}
                >
                  <td className={cn(cellClass, "truncate font-medium")}>
                    {row.conversation}
                  </td>
                  <td className={cellClass}>
                    <ChatTypeCell row={row} />
                  </td>
                  <td className={cn(cellClass, "truncate")}>{row.agentName}</td>
                  {/* No connection record carries a working directory yet. */}
                  <td
                    className={cn(cellClass, "text-faint")}
                    title="接入记录里没有工作目录"
                  >
                    —
                  </td>
                  <td
                    className={cn(cellClass, "truncate text-muted-foreground")}
                  >
                    {row.modelName}
                  </td>
                  <td className={cellClass}>
                    <StatusBadge row={row} />
                  </td>
                  <td className={cellClass}>
                    <RowActions actions={actions} row={row} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function ChatCards({
  rows,
  actions,
}: {
  rows: ChatRow[];
  actions: ChatActions;
}) {
  return (
    <ul
      aria-label="已接入聊天"
      className="grid gap-[11px] [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]"
    >
      {rows.map((row) => (
        <li
          // theme.css `.staff-card`-like plate: graphite, a hairline, 16px corners.
          className="grid gap-3 rounded-[16px] border border-border bg-card px-[14px] py-[12px] text-[13px] shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]"
          key={row.id}
        >
          <div className="flex items-start justify-between gap-2">
            <ChatTypeCell row={row} />
            <StatusBadge row={row} />
          </div>
          <dl className="grid gap-1">
            <Field label="聊天">{row.conversation}</Field>
            <Field label="执行目标">{row.agentName}</Field>
            <Field label="模型">{row.modelName}</Field>
            <Field label="最近送达">{lastDelivery(row)}</Field>
          </dl>
          <RowActions actions={actions} row={row} />
        </li>
      ))}
    </ul>
  );
}

const ALL = "";

/** The 已接入的聊天 section: heading and view switch, toolbar, then the table or the cards. */
export function ConnectedChats({
  rows,
  visible,
  search,
  onSearch,
  loading,
  actions,
  onConnect,
}: {
  /** Every connected chat, before narrowing: decides empty versus no match, and the model list. */
  rows: ChatRow[];
  visible: ChatRow[];
  search: ReachabilitySearch;
  onSearch: (next: Partial<ReachabilitySearch>) => void;
  loading: boolean;
  actions: ChatActions;
  /** Opens the 接入 IM 聊天 flow, offered again from the empty list. */
  onConnect: () => void;
}) {
  const [query, setQuery] = useSearchDraft(search.q ?? "");
  const models = new Map<string, string>();
  for (const row of rows)
    if (row.modelKey) models.set(row.modelKey, row.modelName);
  if (search.model && !models.has(search.model))
    models.set(search.model, "当前筛选的模型");
  const narrowed = Boolean(
    search.q || search.type || search.model || search.status,
  );
  const cards = search.view === "cards";

  const body = loading ? (
    <div aria-busy="true" className="grid gap-2 p-[15px]" role="status">
      <span className="sr-only">正在读取已接入聊天…</span>
      <Skeleton className="h-[40px] w-full" />
      <Skeleton className="h-[40px] w-full" />
      <Skeleton className="h-[40px] w-full" />
    </div>
  ) : rows.length === 0 ? (
    <WorkbenchEmpty
      action={
        <Button
          className="h-[29px] text-[12px]"
          onClick={onConnect}
          variant="outline"
        >
          <IconPlus aria-hidden className="size-[15px]" />
          接入 IM 聊天
        </Button>
      }
      className="min-h-[211px] rounded-none [&>p]:max-w-[560px]"
      description="点击「接入 IM 聊天」，选择机器人或账号、具体群聊或私聊，以及负责响应的员工。"
      mood="naughty"
      title="还没有接入 IM 聊天"
    />
  ) : visible.length === 0 ? (
    <WorkbenchEmpty
      action={
        <Button
          className="h-[29px] text-[12px]"
          variant="outline"
          onClick={() =>
            onSearch({
              q: undefined,
              type: undefined,
              model: undefined,
              status: undefined,
            })
          }
        >
          清除筛选
        </Button>
      }
      className="min-h-[211px] rounded-none [&>p]:max-w-[560px]"
      description="换个关键词，或清除筛选再看全部。"
      mood="cute"
      title="没有符合条件的聊天"
    />
  ) : null;

  return (
    <section aria-labelledby="connected-chats" className="flex flex-col">
      <div className="mb-[9px] flex flex-wrap items-center justify-between gap-[10px]">
        <h2
          className="flex items-center gap-[7px] font-semibold text-[17px] leading-[24px] tracking-[-0.02em]"
          id="connected-chats"
        >
          <IconLink aria-hidden className="size-[18px] text-foreground/85" />
          已接入的聊天
        </h2>
        <SegmentedTabs
          label="视图"
          onValueChange={(value) =>
            onSearch({ view: value === "cards" ? "cards" : undefined })
          }
          size="sm"
          tabs={[
            {
              value: "table",
              label: (
                <>
                  <IconList aria-hidden className="size-[15px]" />
                  列表
                </>
              ),
            },
            {
              value: "cards",
              label: (
                <>
                  <IconLayoutGrid aria-hidden className="size-[15px]" />
                  卡片
                </>
              ),
            },
          ]}
          value={cards ? "cards" : "table"}
        />
      </div>
      <div className="flex flex-wrap items-center gap-[6px]">
        <SearchBox
          className="w-full sm:w-[221px]"
          label="搜索已接入聊天"
          onValueChange={(q) => {
            setQuery(q);
            onSearch({ q: q || undefined });
          }}
          placeholder="搜索聊天、员工或 WakerFlow"
          value={query}
        />
        <LabeledSelect
          label="聊天类型"
          onValueChange={(type) =>
            onSearch({ type: (type || undefined) as ChatType | undefined })
          }
          options={[
            { value: ALL, label: "全部" },
            ...(Object.keys(TYPE_LABELS) as ChatType[]).map((type) => ({
              value: type,
              label: TYPE_LABELS[type],
            })),
          ]}
          value={search.type ?? ALL}
        />
        <LabeledSelect
          className="max-w-full"
          label="模型"
          onValueChange={(model) => onSearch({ model: model || undefined })}
          options={[
            { value: ALL, label: "全部" },
            ...[...models].map(([key, name]) => ({ value: key, label: name })),
          ]}
          value={search.model ?? ALL}
        />
        <LabeledSelect
          label="状态"
          onValueChange={(status) =>
            onSearch({
              status: (status || undefined) as ChatStatus | undefined,
            })
          }
          options={[
            { value: ALL, label: "全部" },
            ...(Object.keys(STATUS_LABELS) as ChatStatus[]).map((status) => ({
              value: status,
              label: STATUS_LABELS[status],
            })),
          ]}
          value={search.status ?? ALL}
        />
      </div>
      <div className="mt-[10px]">
        {cards ? (
          body ? (
            <div className={PANEL}>{body}</div>
          ) : (
            <ChatCards actions={actions} rows={visible} />
          )
        ) : (
          <ChatTable actions={actions} body={body} rows={visible} />
        )}
      </div>
      {narrowed && visible.length > 0 && (
        <p className="mt-3 text-[12px] text-muted-foreground">
          显示 {visible.length} / {rows.length} 个聊天
        </p>
      )}
    </section>
  );
}
