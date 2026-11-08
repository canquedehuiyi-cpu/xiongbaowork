import { IconInfoCircle, IconLayoutGrid, IconList } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LabeledSelect } from "@/components/layout/labeled-select";
import { SearchBox } from "@/components/layout/search-box";
import { SegmentedTabs } from "@/components/layout/segmented-tabs";
import { BearMascot } from "@/components/layout/workbench-empty";
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

const STATUS_TONE: Record<ChatStatus, string> = {
  connected: "bg-primary",
  failed: "bg-destructive",
  optedOut: "bg-muted-foreground",
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
          row.status === "failed" && "text-destructive",
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
 * The table's columns, at the reference's proportions (its 1376px-wide table, measured from
 * docs/acceptance/qoderwake-reference/reachability.png); the 41px checkbox column comes first.
 */
const COLUMNS: { label: string; width?: string; info?: string }[] = [
  { label: "聊天", width: "18.7%" },
  { label: "IM 连接", width: "12.5%" },
  { label: "执行目标", width: "18.6%" },
  { label: "工作目录", width: "8.7%" },
  {
    label: "模型",
    width: "8.7%",
    info: "员工在这段聊天里回复时使用的模型，与员工自己的设置一致。",
  },
  { label: "聊天状态", width: "11.6%" },
  { label: "启用", width: "5.9%" },
  // Takes what is left (≈170px at the reference width): both row actions, at xs, on one line.
  { label: "操作" },
];

const cellClass = "px-4 align-middle";

/**
 * The reference's selection checkbox, drawn as its dim square but disabled: this page has no bulk
 * action to select rows for, so a box that ticked would promise one.
 */
function SelectBox({ label }: { label: string }) {
  return (
    <input
      aria-label={label}
      className="block size-4 cursor-not-allowed appearance-none rounded-[4px] border border-input bg-transparent"
      disabled
      title="暂无批量操作"
      type="checkbox"
    />
  );
}

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
    <div className="overflow-x-auto rounded-[8px] border bg-card dark:border-transparent">
      <table
        aria-label="已接入聊天"
        className="w-full min-w-[1100px] table-fixed text-[13px]"
      >
        <colgroup>
          <col className="w-[41px]" />
          {COLUMNS.map((column) => (
            <col
              key={column.label}
              style={column.width ? { width: column.width } : undefined}
            />
          ))}
        </colgroup>
        <thead className="bg-muted text-left text-[13px] text-foreground/85">
          <tr className="h-[39px]">
            <th className="pl-4 align-middle font-normal">
              <SelectBox label="全选（暂无批量操作）" />
            </th>
            {COLUMNS.map((column) => (
              <th className={cn(cellClass, "font-medium")} key={column.label}>
                <span className="inline-flex items-center gap-1">
                  {column.label}
                  {column.info && (
                    <span className="inline-flex" title={column.info}>
                      <IconInfoCircle
                        aria-hidden
                        className="size-[13px] text-muted-foreground"
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
              <td className="p-0" colSpan={COLUMNS.length + 1}>
                {body}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr className="h-[52px] border-t" key={row.id}>
                <td className="pl-4 align-middle">
                  <SelectBox
                    label={`选择「${row.conversation}」（暂无批量操作）`}
                  />
                </td>
                <td className={cn(cellClass, "truncate")}>
                  {row.conversation}
                </td>
                <td className={cellClass}>
                  <ChatTypeCell row={row} />
                </td>
                <td className={cn(cellClass, "truncate")}>{row.agentName}</td>
                {/* No connection record carries a working directory yet. */}
                <td
                  className={cn(cellClass, "text-muted-foreground")}
                  title="接入记录里没有工作目录"
                >
                  —
                </td>
                <td className={cn(cellClass, "truncate text-muted-foreground")}>
                  {row.modelName}
                </td>
                <td className={cellClass}>
                  <StatusBadge row={row} />
                </td>
                {/*
                 * A fact, not a switch: the server can disconnect a chat but has no way to pause
                 * one, and a disconnected chat is no longer listed — so every row here is enabled.
                 */}
                <td
                  className={cn(cellClass, "text-muted-foreground")}
                  title="接入没有暂停开关；不再需要时用「断开连接」"
                >
                  已启用
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
  );
}

/**
 * What the list says when it has no rows: centred in the table body with the mascot under the
 * words, at the reference's 259px body height.
 */
function BodyMessage({
  title,
  description,
  action,
  mascot,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  mascot?: boolean;
}) {
  return (
    <div className="flex min-h-[259px] flex-col items-center px-6 pt-[110px] pb-[5px] text-center">
      <p className="font-medium text-[14px] leading-[20px]">{title}</p>
      <p className="mt-[4px] text-pretty text-[12px] text-muted-foreground leading-[18px]">
        {description}
      </p>
      {action ? <div className="mt-3">{action}</div> : null}
      {mascot ? <BearMascot className="mt-[38px]" mood="naughty" /> : null}
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
      className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]"
    >
      {rows.map((row) => (
        <li
          className="grid gap-3 rounded-lg border bg-card p-4 text-[13px]"
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
}: {
  /** Every connected chat, before narrowing: decides empty versus no match, and the model list. */
  rows: ChatRow[];
  visible: ChatRow[];
  search: ReachabilitySearch;
  onSearch: (next: Partial<ReachabilitySearch>) => void;
  loading: boolean;
  actions: ChatActions;
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
    <div aria-busy="true" className="grid gap-2 p-4" role="status">
      <span className="sr-only">正在读取已接入聊天…</span>
      <Skeleton className="h-[40px] w-full" />
      <Skeleton className="h-[40px] w-full" />
      <Skeleton className="h-[40px] w-full" />
    </div>
  ) : rows.length === 0 ? (
    <BodyMessage
      description="点击「接入 IM 聊天」，选择机器人或账号、具体群聊或私聊，以及负责响应的员工。"
      mascot
      title="还没有接入 IM 聊天"
    />
  ) : visible.length === 0 ? (
    <BodyMessage
      action={
        <Button
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
      description="换个关键词，或清除筛选再看全部。"
      title="没有符合条件的聊天"
    />
  ) : null;

  return (
    <section aria-labelledby="connected-chats" className="flex flex-col">
      <div className="flex h-[32px] items-center justify-between gap-3">
        <h2
          className="font-semibold text-[16px] leading-[24px]"
          id="connected-chats"
        >
          已接入的聊天
        </h2>
        <SegmentedTabs
          className="bg-sidebar-accent p-[3px] [&>[aria-selected=true]]:!bg-card [&>button]:px-[9px]"
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
                  <span className="sr-only">表格</span>
                </>
              ),
            },
            {
              value: "cards",
              label: (
                <>
                  <IconLayoutGrid aria-hidden className="size-[15px]" />
                  <span className="sr-only">卡片</span>
                </>
              ),
            },
          ]}
          value={cards ? "cards" : "table"}
        />
      </div>
      <div className="mt-[12px] flex flex-wrap items-center gap-[10px]">
        <SearchBox
          className="w-full bg-card sm:w-[218px]"
          label="搜索已接入聊天"
          onValueChange={(q) => {
            setQuery(q);
            onSearch({ q: q || undefined });
          }}
          placeholder="搜索聊天、员工或 WakerFlow"
          value={query}
        />
        <LabeledSelect
          className="min-w-[190px] bg-card"
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
          className="min-w-[158px] bg-card"
          label="模型"
          onValueChange={(model) => onSearch({ model: model || undefined })}
          options={[
            { value: ALL, label: "全部" },
            ...[...models].map(([key, name]) => ({ value: key, label: name })),
          ]}
          value={search.model ?? ALL}
        />
        <LabeledSelect
          className="min-w-[132px] bg-card"
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
      <div className="mt-[13px]">
        {cards ? (
          body ? (
            <div className="rounded-[8px] border bg-card dark:border-transparent">
              {body}
            </div>
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
