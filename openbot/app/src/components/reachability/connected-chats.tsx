import { IconMessages, IconSearch } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SegmentedTabs } from "@/components/layout/segmented-tabs";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
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

const controlClass =
  "h-[32px] rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

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
    <div className="flex flex-wrap justify-end gap-1.5">
      {row.channelId && (
        <Link
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          params={{ channelId: row.channelId }}
          to="/channel/$channelId"
        >
          打开对话
        </Link>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={actions.removing}
        onClick={() => actions.onRemove(row)}
      >
        {row.kind === "device" ? "移除设备" : "断开连接"}
      </Button>
    </div>
  );
}

function ChatTable({
  rows,
  actions,
}: {
  rows: ChatRow[];
  actions: ChatActions;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table
        aria-label="已接入聊天"
        className="w-full min-w-[720px] text-[13px]"
      >
        <thead className="bg-foreground/[0.03] text-left text-[12px] text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">聊天类型</th>
            <th className="px-3 py-2 font-medium">会话</th>
            <th className="px-3 py-2 font-medium">员工</th>
            <th className="px-3 py-2 font-medium">模型</th>
            <th className="px-3 py-2 font-medium">状态</th>
            <th className="px-3 py-2 font-medium">最近送达</th>
            <th className="px-3 py-2 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-t align-middle" key={row.id}>
              <td className="px-3 py-2">
                <ChatTypeCell row={row} />
              </td>
              <td className="max-w-[260px] truncate px-3 py-2">
                {row.conversation}
              </td>
              <td className="px-3 py-2">{row.agentName}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {row.modelName}
              </td>
              <td className="px-3 py-2">
                <StatusBadge row={row} />
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {lastDelivery(row)}
              </td>
              <td className="px-3 py-2">
                <RowActions actions={actions} row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
            <Field label="会话">{row.conversation}</Field>
            <Field label="员工">{row.agentName}</Field>
            <Field label="模型">{row.modelName}</Field>
            <Field label="最近送达">{lastDelivery(row)}</Field>
          </dl>
          <RowActions actions={actions} row={row} />
        </li>
      ))}
    </ul>
  );
}

/** The 已接入聊天 section: toolbar, then the table or the cards, or why there is nothing. */
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
  onConnect: () => void;
}) {
  const models = new Map<string, string>();
  for (const row of rows)
    if (row.modelKey) models.set(row.modelKey, row.modelName);
  if (search.model && !models.has(search.model))
    models.set(search.model, "当前筛选的模型");
  const narrowed = Boolean(
    search.q || search.type || search.model || search.status,
  );
  return (
    <section aria-labelledby="connected-chats" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold" id="connected-chats">
          已接入聊天
          <span className="ml-2 text-[13px] font-normal text-muted-foreground tabular-nums">
            {rows.length}
          </span>
        </h2>
        <SegmentedTabs
          label="视图"
          onValueChange={(value) =>
            onSearch({ view: value === "cards" ? "cards" : undefined })
          }
          tabs={[
            { value: "table", label: "表格" },
            { value: "cards", label: "卡片" },
          ]}
          value={search.view === "cards" ? "cards" : "table"}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-[260px]">
          <IconSearch
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            aria-label="搜索已接入聊天"
            className={cn(controlClass, "w-full pl-8")}
            onChange={(event) =>
              onSearch({ q: event.target.value || undefined })
            }
            placeholder="搜索会话、员工或号码"
            type="search"
            value={search.q ?? ""}
          />
        </div>
        <select
          aria-label="聊天类型"
          className={controlClass}
          onChange={(event) =>
            onSearch({
              type: (event.target.value || undefined) as ChatType | undefined,
            })
          }
          value={search.type ?? ""}
        >
          <option value="">全部聊天类型</option>
          {(Object.keys(TYPE_LABELS) as ChatType[]).map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        <select
          aria-label="模型"
          className={controlClass}
          onChange={(event) =>
            onSearch({ model: event.target.value || undefined })
          }
          value={search.model ?? ""}
        >
          <option value="">全部模型</option>
          {[...models].map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="状态"
          className={controlClass}
          onChange={(event) =>
            onSearch({
              status: (event.target.value || undefined) as
                | ChatStatus
                | undefined,
            })
          }
          value={search.status ?? ""}
        >
          <option value="">全部状态</option>
          {(Object.keys(STATUS_LABELS) as ChatStatus[]).map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>
      {loading ? (
        <div className="grid gap-2" aria-busy="true" role="status">
          <span className="sr-only">正在读取已接入聊天…</span>
          <Skeleton className="h-[40px] w-full" />
          <Skeleton className="h-[40px] w-full" />
          <Skeleton className="h-[40px] w-full" />
        </div>
      ) : rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconMessages />
            </EmptyMedia>
            <EmptyTitle>还没有接入任何聊天</EmptyTitle>
            <EmptyDescription>
              把一段对话关联到 Slack、Microsoft Teams
              或手机号，员工的回复、提问和审批请求就会送到那里。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onConnect}>接入 IM 聊天</Button>
          </EmptyContent>
        </Empty>
      ) : visible.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>没有符合条件的聊天</EmptyTitle>
            <EmptyDescription>
              换个关键词，或清除筛选再看全部。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
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
          </EmptyContent>
        </Empty>
      ) : search.view === "cards" ? (
        <ChatCards actions={actions} rows={visible} />
      ) : (
        <ChatTable actions={actions} rows={visible} />
      )}
      {narrowed && visible.length > 0 && (
        <p className="text-[12px] text-muted-foreground">
          显示 {visible.length} / {rows.length} 个聊天
        </p>
      )}
    </section>
  );
}
